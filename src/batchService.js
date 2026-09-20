// 批次闭环服务：开批 → 初测 → (待复测 → 复测)* → 连续两次合格 → 封存。
// 业务规则全部在这里编排；档案、补偿规则、存储分别来自三个独立模块。

import { DEFAULT_RULES, evaluateReading, isQualified } from "./compensationRules.js";

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

export function createBatchService({ archive, store, rules = DEFAULT_RULES }) {
  /** 当前有效（未失效）的批次 */
  const validBatches = (db) => db.batches.filter((b) => !b.invalidatedAt);
  const findBatch = (db, batchId) => db.batches.find((b) => b.id === batchId);
  const batchMeasurements = (db, batchId) =>
    db.measurements.filter((m) => m.batchId === batchId).sort((a, b) => a.seq - b.seq);

  /** 重算批次的连续合格数与状态（初测/复测/修订共用） */
  function refreshConclusion(db, batch) {
    const rigging = archive.getRigging(batch.riggingId);
    const nominal = rigging ? rigging.nominal : null;
    const ms = batchMeasurements(db, batch.id);

    let streak = 0;
    for (const m of ms) {
      if (m.needsRecheck) {
        streak = 0; // 待复测读数打断连续合格
        continue;
      }
      streak = isQualified(m.compensated, nominal, rules) ? streak + 1 : 0;
    }
    batch.consecutiveQualified = streak;

    const last = ms[ms.length - 1];
    if (streak >= rules.requiredConsecutivePass) batch.status = "READY_TO_SEAL";
    else if (last && last.needsRecheck) batch.status = "PENDING_RECHECK";
    else if (last) batch.status = "IN_PROGRESS";
    else batch.status = "OPEN";
    return batch;
  }

  /** 录一条测量（初测或复测），并按环境补偿规则评估 */
  async function record(batchId, input, kind) {
    const rawValue = Number(input.value);
    const temperature = Number(input.temperature);
    if (!Number.isFinite(rawValue)) fail(400, "VALIDATION", "读数必须为数字");
    if (!Number.isFinite(temperature)) fail(400, "VALIDATION", "温度必须为数字");
    if (!input.operator) fail(400, "VALIDATION", "操作人不能为空");

    return store.transact((db) => {
      const batch = findBatch(db, batchId);
      if (!batch) fail(404, "BATCH_NOT_FOUND", "批次不存在");
      if (batch.invalidatedAt) fail(409, "BATCH_INVALIDATED", "批次已失效，不能继续测量");
      if (batch.status === "SEALED") fail(409, "BATCH_SEALED", "批次已封存，不能继续测量");

      const ms = batchMeasurements(db, batchId);
      const prev = ms[ms.length - 1] || null;

      if (kind === "RECHECK") {
        if (!prev) fail(409, "NO_INITIAL", "尚无初测记录，无法复测");
        if (prev.operator === input.operator) fail(409, "SAME_OPERATOR", "复测须换人操作");
      }

      const evaluation = evaluateReading(
        { rawValue, temperature, previousCompensated: prev ? prev.compensated : null },
        rules,
      );
      const measurement = {
        id: nextId("MEA"),
        batchId,
        seq: (prev ? prev.seq : 0) + 1,
        kind,
        point: input.point || null,
        rawValue,
        temperature,
        compensated: evaluation.compensated,
        needsRecheck: evaluation.needsRecheck,
        reasons: evaluation.reasons,
        operator: input.operator,
        at: new Date().toISOString(),
      };
      db.measurements.push(measurement);
      refreshConclusion(db, batch);
      return { measurement: structuredClone(measurement), batch: structuredClone(batch) };
    });
  }

  return {
    /**
     * 开批：同一船台（benchId）同时仅允许一个开放批次。
     * 重复或并发开批 → 409，且不落库（在事务内抛错，事务不会写盘）。
     */
    async openBatch(input = {}) {
      if (!input.benchId) fail(400, "VALIDATION", "benchId 不能为空");
      if (!archive.getRigging(input.riggingId)) fail(404, "RIGGING_NOT_FOUND", "索具测点不存在");
      return store.transact((db) => {
        const open = validBatches(db).find((b) => b.benchId === input.benchId && b.status !== "SEALED");
        if (open) fail(409, "BATCH_CONFLICT", `船台 ${input.benchId} 已存在开放批次 ${open.id}`);
        const batch = {
          id: nextId("BAT"),
          benchId: input.benchId,
          riggingId: input.riggingId,
          operator: input.operator || "",
          status: "OPEN",
          consecutiveQualified: 0,
          invalidatedAt: null,
          invalidationReason: null,
          revisionCount: 0,
          createdAt: new Date().toISOString(),
        };
        db.batches.push(batch);
        return structuredClone(batch);
      });
    },

    /**
     * 提交初测：读数 + 温度 + 测点，读数按 20℃ 折算。
     * 温度越界 5–35℃ 或相邻读数差超 8% → 转待复测。
     */
    submitInitial(batchId, input = {}) {
      return record(batchId, input, "INITIAL");
    },

    /** 提交复测：必须换人（operator 不得与上一次测量相同）。 */
    submitRecheck(batchId, input = {}) {
      return record(batchId, input, "RECHECK");
    },

    /**
     * 修订初测：批次、结论和统计立即失效。
     * 旧快照（封存结论 + 全部测量）保留在 invalidatedSnapshots，不计入当前统计；
     * 修订后的初测作为第 1 条记录重新进入闭环。
     */
    async reviseInitial(batchId, input = {}) {
      const rawValue = Number(input.value);
      const temperature = Number(input.temperature);
      if (!Number.isFinite(rawValue)) fail(400, "VALIDATION", "读数必须为数字");
      if (!Number.isFinite(temperature)) fail(400, "VALIDATION", "温度必须为数字");

      return store.transact((db) => {
        const batch = findBatch(db, batchId);
        if (!batch) fail(404, "BATCH_NOT_FOUND", "批次不存在");
        if (batch.invalidatedAt) fail(409, "BATCH_INVALIDATED", "批次已失效");
        const initial = batchMeasurements(db, batchId).find((m) => m.kind === "INITIAL");
        if (!initial) fail(404, "NO_INITIAL", "尚无初测记录可修订");

        // 旧快照保留：封存结论 + 全部测量，整体移入失效快照区
        db.invalidatedSnapshots.push({
          batchId,
          invalidatedAt: new Date().toISOString(),
          reason: input.reason || "修订初测",
          seal: db.seals.find((s) => s.batchId === batchId) || null,
          measurements: batchMeasurements(db, batchId).map((m) => structuredClone(m)),
        });
        db.seals = db.seals.filter((s) => s.batchId !== batchId);
        db.measurements = db.measurements.filter((m) => m.batchId !== batchId);

        // 批次与结论立即失效：连续合格清零，回到开批状态
        batch.consecutiveQualified = 0;
        batch.status = "OPEN";
        batch.revisionCount += 1;
        batch.invalidationReason = input.reason || "修订初测";

        // 修订后的初测重新评估（无相邻读数，视作新闭环起点）
        const evaluation = evaluateReading({ rawValue, temperature, previousCompensated: null }, rules);
        db.measurements.push({
          id: nextId("MEA"),
          batchId,
          seq: 1,
          kind: "INITIAL",
          point: input.point || initial.point,
          rawValue,
          temperature,
          compensated: evaluation.compensated,
          needsRecheck: evaluation.needsRecheck,
          reasons: evaluation.reasons,
          operator: input.operator || initial.operator,
          revisedFrom: initial.id,
          at: new Date().toISOString(),
        });
        refreshConclusion(db, batch);
        return structuredClone(batch);
      });
    },

    /**
     * 封存：须连续两次折算值合格。
     * 重复封存沿用首次结果（幂等，不产生第二条封存记录）。
     */
    async seal(batchId, input = {}) {
      return store.transact((db) => {
        const batch = findBatch(db, batchId);
        if (!batch) fail(404, "BATCH_NOT_FOUND", "批次不存在");
        if (batch.invalidatedAt) fail(409, "BATCH_INVALIDATED", "批次已失效，不能封存");

        const existing = db.seals.find((s) => s.batchId === batchId);
        if (existing) return { seal: structuredClone(existing), duplicated: true };

        if (batch.consecutiveQualified < rules.requiredConsecutivePass) {
          fail(409, "NOT_READY", `需连续${rules.requiredConsecutivePass}次折算值合格才可封存`);
        }
        const ms = batchMeasurements(db, batchId);
        const seal = {
          id: nextId("SEA"),
          batchId,
          sealedBy: input.operator || batch.operator,
          sealedAt: new Date().toISOString(),
          conclusion: {
            riggingId: batch.riggingId,
            referenceTemp: rules.referenceTemp,
            finalCompensated: ms[ms.length - 1].compensated,
            measurementCount: ms.length,
            qualifiedStreak: batch.consecutiveQualified,
          },
        };
        db.seals.push(seal);
        batch.status = "SEALED";
        return { seal: structuredClone(seal), duplicated: false };
      });
    },

    /** 当前统计：仅统计有效批次的封存结论；失效快照不计入 */
    async stats() {
      const db = await store.read();
      const validIds = new Set(validBatches(db).map((b) => b.id));
      const seals = db.seals.filter((s) => validIds.has(s.batchId));
      const byBench = {};
      for (const s of seals) {
        const batch = db.batches.find((b) => b.id === s.batchId);
        byBench[batch.benchId] = (byBench[batch.benchId] || 0) + 1;
      }
      return {
        sealedCount: seals.length,
        invalidatedSnapshotCount: db.invalidatedSnapshots.length,
        byBench,
        seals: seals.map((s) => structuredClone(s)),
      };
    },

    async getBatch(batchId) {
      const db = await store.read();
      const batch = findBatch(db, batchId);
      if (!batch) return null;
      return {
        ...structuredClone(batch),
        measurements: batchMeasurements(db, batchId).map((m) => structuredClone(m)),
        seal: structuredClone(db.seals.find((s) => s.batchId === batchId) || null),
      };
    },

    async listBatches() {
      const db = await store.read();
      return db.batches.map((b) => structuredClone(b));
    },
  };
}
