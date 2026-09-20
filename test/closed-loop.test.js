// 端到端闭环测试：真实启动服务，覆盖
// 开批冲突(409不落库) / 并发开批 / 温度越界与相邻差转待复测 / 复测换人 /
// 连续两次合格封存 / 重复封存幂等 / 修订初测使批次-结论-统计失效且旧快照保留。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
let child;
let dataFile;
let tmpDir;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function readDb() {
  return JSON.parse(await readFile(dataFile, "utf8"));
}

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rigging-test-"));
  dataFile = join(tmpDir, "test-data.json");
  child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      await api("/api/stats");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("服务启动超时");
});

after(async () => {
  child.kill();
  await rm(tmpDir, { recursive: true, force: true });
});

test("闭环全流程", async (t) => {
  let modelId, riggingId;

  await t.test("模型建档与测点登记", async () => {
    const model = await api("/api/models", {
      method: "POST",
      body: { code: "MR-100", shipType: "福船", scale: "1:48", owner: "周宁" },
    });
    assert.equal(model.status, 201);
    modelId = model.data.id;

    const rig = await api(`/api/models/${modelId}/riggings`, {
      method: "POST",
      body: { point: "前桅侧支索", nominal: 100 },
    });
    assert.equal(rig.status, 201);
    riggingId = rig.data.id;
  });

  let batchA;
  await t.test("开批：重复开批返回409且不落库", async () => {
    const r1 = await api("/api/batches", {
      method: "POST",
      body: { benchId: "船台A", riggingId, operator: "张三" },
    });
    assert.equal(r1.status, 201);
    batchA = r1.data.id;

    const before = (await readDb()).batches.length;
    const r2 = await api("/api/batches", {
      method: "POST",
      body: { benchId: "船台A", riggingId, operator: "李四" },
    });
    assert.equal(r2.status, 409);
    assert.equal(r2.data.error, "BATCH_CONFLICT");
    assert.equal((await readDb()).batches.length, before, "409 不应落库");
  });

  await t.test("并发开批：仅一个成功，其余409", async () => {
    const [a, b] = await Promise.all([
      api("/api/batches", { method: "POST", body: { benchId: "船台B", riggingId, operator: "张三" } }),
      api("/api/batches", { method: "POST", body: { benchId: "船台B", riggingId, operator: "李四" } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const db = await readDb();
    assert.equal(db.batches.filter((x) => x.benchId === "船台B").length, 1, "并发下只落库一个批次");
  });

  await t.test("初测：温度越界5–35℃转待复测", async () => {
    const r = await api(`/api/batches/${batchA}/initial`, {
      method: "POST",
      body: { value: 100, temperature: 40, operator: "张三", point: "前桅侧支索" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.measurement.needsRecheck, true);
    assert.ok(r.data.measurement.reasons.some((x) => x.includes("温度越界")));
    assert.equal(r.data.batch.status, "PENDING_RECHECK");
    // 折算校验：100 / (1 + 0.002 * (40 - 20)) = 96.1538…
    assert.ok(Math.abs(r.data.measurement.compensated - 100 / 1.04) < 1e-9);
  });

  await t.test("复测须换人：同人复测返回409", async () => {
    const r = await api(`/api/batches/${batchA}/recheck`, {
      method: "POST",
      body: { value: 100, temperature: 20, operator: "张三" },
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "SAME_OPERATOR");
  });

  let firstSealId;
  await t.test("相邻差超8%转待复测，连续两次合格后才可封存", async () => {
    // 换人复测，读数回到正常（与上次折算值差约4%，不越界）→ 合格 ×1
    const ok = await api(`/api/batches/${batchA}/recheck`, {
      method: "POST",
      body: { value: 100, temperature: 20, operator: "李四" },
    });
    assert.equal(ok.data.measurement.needsRecheck, false);
    assert.equal(ok.data.batch.consecutiveQualified, 1);

    // 相邻差 9% > 8% → 待复测，连续合格清零
    const jump = await api(`/api/batches/${batchA}/recheck`, {
      method: "POST",
      body: { value: 109, temperature: 20, operator: "张三" },
    });
    assert.equal(jump.data.measurement.needsRecheck, true);
    assert.ok(jump.data.measurement.reasons.some((x) => x.includes("相邻读数差超8%")));
    assert.equal(jump.data.batch.status, "PENDING_RECHECK");
    assert.equal(jump.data.batch.consecutiveQualified, 0);

    // 未达标时封存 → 409
    const early = await api(`/api/batches/${batchA}/seal`, { method: "POST", body: {} });
    assert.equal(early.status, 409);
    assert.equal(early.data.error, "NOT_READY");

    // 逐步回到标称值附近（每步与上次差 <8%），连续两次合格
    const q1 = await api(`/api/batches/${batchA}/recheck`, {
      method: "POST",
      body: { value: 100.5, temperature: 20, operator: "李四" },
    });
    assert.equal(q1.data.batch.consecutiveQualified, 1);
    const q2 = await api(`/api/batches/${batchA}/recheck`, {
      method: "POST",
      body: { value: 100.2, temperature: 20, operator: "张三" },
    });
    assert.equal(q2.data.batch.consecutiveQualified, 2);
    assert.equal(q2.data.batch.status, "READY_TO_SEAL");

    const seal = await api(`/api/batches/${batchA}/seal`, {
      method: "POST",
      body: { operator: "王五" },
    });
    assert.equal(seal.status, 200);
    assert.equal(seal.data.duplicated, false);
    firstSealId = seal.data.seal.id;
    assert.ok(Math.abs(seal.data.seal.conclusion.finalCompensated - 100.2) < 1e-9);
  });

  await t.test("重复封存沿用首次结果", async () => {
    const again = await api(`/api/batches/${batchA}/seal`, {
      method: "POST",
      body: { operator: "赵六" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.duplicated, true);
    assert.equal(again.data.seal.id, firstSealId, "沿用首次封存结果");
    const db = await readDb();
    assert.equal(db.seals.filter((s) => s.batchId === batchA).length, 1, "不产生第二条封存记录");
  });

  await t.test("封存后船台可开新批；统计只计有效封存", async () => {
    const r = await api("/api/batches", {
      method: "POST",
      body: { benchId: "船台A", riggingId, operator: "张三" },
    });
    assert.equal(r.status, 201);
    const stats = await api("/api/stats");
    assert.equal(stats.data.sealedCount, 1);
    assert.equal(stats.data.byBench["船台A"], 1);
  });

  let batchB;
  await t.test("修订初测：批次、结论和统计立即失效，旧快照保留", async () => {
    // 船台B的批次：走通两次合格后封存
    const list = await api("/api/batches");
    batchB = list.data.find((b) => b.benchId === "船台B").id;
    await api(`/api/batches/${batchB}/initial`, {
      method: "POST",
      body: { value: 100, temperature: 20, operator: "张三" },
    });
    await api(`/api/batches/${batchB}/recheck`, {
      method: "POST",
      body: { value: 100, temperature: 20, operator: "李四" },
    });
    const seal = await api(`/api/batches/${batchB}/seal`, { method: "POST", body: {} });
    assert.equal(seal.status, 200);
    assert.equal((await api("/api/stats")).data.sealedCount, 2);

    // 修订初测 → 批次与结论立即失效，统计立即回落
    const rev = await api(`/api/batches/${batchB}/revise-initial`, {
      method: "POST",
      body: { value: 99, temperature: 20, operator: "张三", reason: "初测读数笔误" },
    });
    assert.equal(rev.status, 200);
    assert.equal(rev.data.revisionCount, 1);
    assert.equal(rev.data.consecutiveQualified, 1, "修订后的初测重新计入连续合格");

    const stats = await api("/api/stats");
    assert.equal(stats.data.sealedCount, 1, "失效封存的结论不计入当前统计");
    assert.equal(stats.data.invalidatedSnapshotCount, 1);

    // 旧快照保留：原封存结论与全部测量都在快照区
    const db = await readDb();
    const snap = db.invalidatedSnapshots.find((s) => s.batchId === batchB);
    assert.ok(snap, "旧快照应保留");
    assert.ok(snap.seal, "快照含原封存结论");
    assert.equal(snap.measurements.length, 2, "快照含原测量记录");
    assert.equal(db.seals.some((s) => s.batchId === batchB), false, "当前封存中已移除");
    assert.equal(db.measurements.filter((m) => m.batchId === batchB).length, 1, "当前仅余修订后的初测");
  });

  await t.test("修订后重新走闭环可再次封存", async () => {
    const q = await api(`/api/batches/${batchB}/recheck`, {
      method: "POST",
      body: { value: 99.5, temperature: 20, operator: "李四" },
    });
    assert.equal(q.data.batch.consecutiveQualified, 2);
    const seal = await api(`/api/batches/${batchB}/seal`, { method: "POST", body: {} });
    assert.equal(seal.status, 200);
    assert.equal(seal.data.duplicated, false);
    assert.equal((await api("/api/stats")).data.sealedCount, 2);
  });
});
