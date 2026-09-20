import http from "node:http";
import { getRules } from "./src/compensation.js";
import { createModel, listModels } from "./src/modelArchive.js";
import {
  addInitial,
  addRemeasure,
  getBatch,
  listBatches,
  listSnapshots,
  openBatch,
  reviseInitial,
  sealBatch,
  stats
} from "./src/recordStore.js";

const port = Number(process.env.PORT || 3038);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
const ERROR_STATUS = { invalid_input: 400, not_found: 404, model_not_found: 404 };
function sendResult(res, result, okStatus = 200) {
  if (result?.error) return send(res, ERROR_STATUS[result.error] || 409, result);
  send(res, okStatus, result);
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准 · 环境补偿闭环</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; }
    button.ghost { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; width:fit-content; }
    .warn { color:var(--warn); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; }
    th { color:var(--muted); font-weight:400; }
    section { display:grid; gap:14px; align-content:start; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索校准台</h1><div class="meta">环境补偿与批次封存闭环 · 读数统一按 20℃ 折算 · 测点允许 5–35℃ · 相邻读数差 ≤8%</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="modelForm"><h2>模型档案</h2><div id="modelFields"></div><button>建档</button></form>
      <form id="batchForm"><h2>开放批次</h2>
        <label>船台</label><input name="station" required placeholder="如 ST-1">
        <label>模型</label><select name="modelCode" id="batchModel"></select>
        <button>开批</button>
        <div class="meta">同一船台同时仅允许一个开放批次，重复或并发开批返回 409 且不落库。</div>
      </form>
      <form id="measureForm"><h2>测量记录</h2>
        <label>批次</label><select name="batchId" id="measureBatch"></select>
        <label>类型</label><select name="kind">
          <option value="initial">初测</option>
          <option value="remeasure">复测（须换人）</option>
          <option value="revise">修订初测（批次立即失效）</option>
        </select>
        <label>测点</label><input name="point" required placeholder="如 前桅侧支索">
        <label>温度 ℃</label><input name="temp" type="number" step="0.1" required>
        <label>读数</label><input name="value" type="number" step="0.01" required>
        <label>操作人</label><input name="operator" required>
        <button>提交</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel"><h2>批次</h2><div class="grid" id="batches"></div></div>
      <div class="panel"><h2>失效快照（保留但不计入当前统计）</h2><div id="snapshots" class="meta"></div></div>
    </section>
  </main>
  <script>
    const modelFields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const statusLabel = { open:"开放中", pending_remeasure:"待复测", sealed:"已封存", void:"已失效" };
    let models = [], batches = [], snapshots = [], stats = {};
    const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error((data.message || data.error || "请求失败") + "（" + res.status + "）");
      return data;
    }
    async function run(p) { try { await p; } catch (e) { alert(e.message); } await load(); }
    function renderForms() {
      document.querySelector("#modelFields").innerHTML = modelFields.map(([key,label,type]) =>
        "<label>" + label + "</label><input name=\\"" + key + "\\" type=\\"" + type + "\\" " + (key === "code" ? "required" : "") + ">").join("");
    }
    function render() {
      const statCards = [["开放中","open"],["待复测","pending_remeasure"],["已封存","sealed"],["已失效","void"],["保留快照","snapshots"]];
      document.querySelector("#stats").innerHTML = statCards.map(([k,key]) =>
        '<div class="stat"><span>' + k + '</span><strong>' + (stats[key] ?? 0) + "</strong></div>").join("");
      document.querySelector("#batchModel").innerHTML = models.map(m =>
        '<option value="' + esc(m.code) + '">' + esc(m.code) + " · " + esc(m.shipType || "") + "</option>").join("");
      const active = batches.filter(b => b.status === "open" || b.status === "pending_remeasure");
      document.querySelector("#measureBatch").innerHTML = active.map(b =>
        '<option value="' + esc(b.id) + '">' + esc(b.id) + " · " + esc(b.station) + " · " + esc(b.modelCode) + "</option>").join("");
      document.querySelector("#batches").innerHTML = batches.map(batchCard).join("") || '<div class="meta">暂无批次</div>';
      document.querySelector("#snapshots").innerHTML = snapshots.map(s =>
        "<div>" + esc(s.at) + " · " + esc(s.batch.id) + " · " + esc(s.batch.station) + " · 原因 " + esc(s.reason) +
        " · 原结论 " + esc(s.batch.conclusion ? s.batch.conclusion.result : "无") + "</div>").join("") || "暂无";
      document.querySelectorAll("[data-seal]").forEach(btn => btn.onclick = () =>
        run(api("/api/batches/" + btn.dataset.seal + "/seal", { method:"POST", body:"{}" })));
    }
    function batchCard(b) {
      const rows = b.measurements.map(m =>
        "<tr><td>" + (m.kind === "initial" ? "初测" : "复测") + "</td><td>" + esc(m.point) + "</td><td>" + m.temp +
        "℃</td><td>" + m.value + "</td><td>" + m.converted + "</td><td>" + esc(m.operator) + "</td><td>" +
        (m.qualified ? "合格" : '<span class="warn">待复测</span>') + "</td></tr>").join("");
      const table = rows ? "<table><tr><th>类型</th><th>测点</th><th>温度</th><th>读数</th><th>折算@20℃</th><th>操作人</th><th>判定</th></tr>" + rows + "</table>" : '<div class="meta">暂无测量</div>';
      const conclusion = b.conclusion ? '<div class="meta">结论：' + esc(b.conclusion.result) + " · 封存于 " + esc(b.conclusion.sealedAt) + "</div>" : "";
      const voidInfo = b.status === "void" ? '<div class="warn">已失效（' + esc(b.voidReason || "") + "），快照保留但不计入统计</div>" : "";
      const sealBtn = (b.status === "open" || b.status === "pending_remeasure") ? '<button data-seal="' + esc(b.id) + '">封存</button>' : "";
      return '<article class="card"><h3>' + esc(b.id) + " · " + esc(b.station) + '</h3><span class="pill">' + statusLabel[b.status] +
        '</span><div class="meta">模型 ' + esc(b.modelCode) + " · 开批 " + esc(b.createdAt) + "</div>" + table + conclusion + voidInfo + sealBtn + "</article>";
    }
    async function load() {
      [models, batches, snapshots, stats] = await Promise.all([
        api("/api/models"), api("/api/batches"), api("/api/snapshots"), api("/api/stats")]);
      render();
    }
    document.querySelector("#modelForm").onsubmit = event => {
      event.preventDefault();
      run(api("/api/models", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) })
        .then(() => event.target.reset()));
    };
    document.querySelector("#batchForm").onsubmit = event => {
      event.preventDefault();
      run(api("/api/batches", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }));
    };
    document.querySelector("#measureForm").onsubmit = event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const id = data.batchId; delete data.batchId;
      const kind = data.kind; delete data.kind;
      const path = kind === "revise" ? "/api/batches/" + id + "/initial" : "/api/batches/" + id + "/" + kind;
      run(api(path, { method: kind === "revise" ? "PATCH" : "POST", body: JSON.stringify(data) }));
    };
    document.querySelector("#reload").onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    // 模型档案
    if (req.method === "GET" && url.pathname === "/api/models") return send(res, 200, await listModels());
    if (req.method === "POST" && url.pathname === "/api/models") {
      return sendResult(res, await createModel(await body(req)), 201);
    }

    // 补偿规则
    if (req.method === "GET" && url.pathname === "/api/compensation/rules") return send(res, 200, getRules());

    // 批次
    if (req.method === "GET" && url.pathname === "/api/batches") {
      return send(res, 200, await listBatches(url.searchParams.get("station") || undefined));
    }
    if (req.method === "POST" && url.pathname === "/api/batches") {
      return sendResult(res, await openBatch(await body(req)), 201);
    }
    const batchGet = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
    if (batchGet && req.method === "GET") {
      const batch = await getBatch(batchGet[1]);
      return batch ? send(res, 200, batch) : send(res, 404, { error: "not_found", message: "批次不存在" });
    }
    const initial = url.pathname.match(/^\/api\/batches\/([^/]+)\/initial$/);
    if (initial && req.method === "POST") return sendResult(res, await addInitial(initial[1], await body(req)), 201);
    if (initial && req.method === "PATCH") return sendResult(res, await reviseInitial(initial[1], await body(req)));
    const remeasure = url.pathname.match(/^\/api\/batches\/([^/]+)\/remeasure$/);
    if (remeasure && req.method === "POST") return sendResult(res, await addRemeasure(remeasure[1], await body(req)), 201);
    const seal = url.pathname.match(/^\/api\/batches\/([^/]+)\/seal$/);
    if (seal && req.method === "POST") return sendResult(res, await sealBatch(seal[1], await body(req)));

    // 快照与统计
    if (req.method === "GET" && url.pathname === "/api/snapshots") return send(res, 200, await listSnapshots());
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, await stats());

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准闭环 listening on http://localhost:" + port));
