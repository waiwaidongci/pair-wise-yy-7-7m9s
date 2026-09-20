import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelArchive } from "./src/modelArchive.js";
import { DEFAULT_RULES } from "./src/compensationRules.js";
import { createRecordStore } from "./src/recordStore.js";
import { createBatchService } from "./src/batchService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3038);
const dataFile = process.env.DATA_FILE || join(__dirname, "data", "calibration-batches.json");

// 三块独立实现：模型档案 / 补偿规则 / 记录存储，批次服务只做编排
const archive = createModelArchive();
const store = createRecordStore(dataFile);
const batches = createBatchService({ archive, store, rules: DEFAULT_RULES });

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

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准 · 批次闭环</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:10px; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .warn { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:13px; } td,th { border-bottom:1px solid var(--line); padding:5px 6px; text-align:left; }
    .row { display:flex; gap:8px; flex-wrap:wrap; } .row button { margin-top:0; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准 · 批次闭环</h1><div class="meta">环境补偿（20℃折算）· 一船台一开放批次 · 连续两次合格封存</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="modelForm"><h2>模型建档</h2>
        <label>模型编号</label><input name="code" required>
        <label>船型</label><input name="shipType">
        <label>比例</label><input name="scale">
        <label>帆索材料</label><input name="riggingMaterial">
        <label>负责人</label><input name="owner">
        <button>保存模型</button>
      </form>
      <form id="riggingForm" style="margin-top:14px"><h2>登记索具测点</h2>
        <label>选择模型</label><select name="modelId" id="modelSelect"></select>
        <label>测点名称</label><input name="point" required placeholder="如：前桅侧支索">
        <label>部位说明</label><input name="position">
        <label>标称值（20℃）</label><input name="nominal" type="number" step="any">
        <button>登记测点</button>
      </form>
      <form id="openForm" style="margin-top:14px"><h2>开批</h2>
        <label>船台</label><input name="benchId" required placeholder="如：船台A">
        <label>索具测点</label><select name="riggingId" id="riggingSelect"></select>
        <label>操作人</label><input name="operator" required>
        <button>开启批次</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel"><h2>批次列表</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    let models = [], riggings = [], batchList = [], stats = null;
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error((data.error || '请求失败') + (data.message ? '：' + data.message : ''));
      return data;
    }
    async function load() {
      models = await api('/api/models');
      riggings = (await Promise.all(models.map(m => api('/api/models/' + m.id + '/riggings')))).flat();
      batchList = await api('/api/batches');
      stats = await api('/api/stats');
      render();
    }
    function render() {
      document.querySelector('#modelSelect').innerHTML = models.map(m => '<option value="' + m.id + '">' + m.code + ' · ' + (m.shipType || '') + '</option>').join('');
      document.querySelector('#riggingSelect').innerHTML = riggings.map(r => '<option value="' + r.id + '">' + r.point + (r.nominal != null ? '（标称 ' + r.nominal + '）' : '') + '</option>').join('');
      document.querySelector('#stats').innerHTML =
        '<div class="stat"><span>有效封存</span><strong>' + stats.sealedCount + '</strong></div>' +
        '<div class="stat"><span>失效快照（不计入）</span><strong>' + stats.invalidatedSnapshotCount + '</strong></div>' +
        Object.entries(stats.byBench).map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
      document.querySelector('#cards').innerHTML = batchList.map(cardHtml).join('') || '<div class="meta">暂无批次</div>';
      batchList.forEach(b => {
        const el = document.querySelector('[data-detail="' + b.id + '"]');
        api('/api/batches/' + b.id).then(d => { el.innerHTML = detailHtml(d); bindActions(d); });
      });
    }
    function cardHtml(b) {
      const r = riggings.find(x => x.id === b.riggingId);
      return '<article class="card"><h3>' + b.id + ' <span class="pill">' + b.status + '</span></h3>' +
        '<div class="meta">船台 ' + b.benchId + ' · 测点 ' + (r ? r.point : b.riggingId) + ' · 连续合格 ' + b.consecutiveQualified + '/2' + (b.revisionCount ? ' · 修订 ' + b.revisionCount + ' 次' : '') + '</div>' +
        '<div data-detail="' + b.id + '" class="meta">加载中…</div></article>';
    }
    function detailHtml(d) {
      const rows = d.measurements.map(m =>
        '<tr><td>' + m.seq + '</td><td>' + m.kind + '</td><td>' + m.rawValue + '</td><td>' + m.temperature + '℃</td>' +
        '<td>' + m.compensated.toFixed(4) + '</td><td>' + m.operator + '</td>' +
        '<td>' + (m.needsRecheck ? '<span class="warn">待复测 ' + m.reasons.join('；') + '</span>' : '<span class="ok">有效</span>') + '</td></tr>').join('');
      const seal = d.seal ? '<div class="ok">已封存 · ' + d.seal.sealedAt + ' · 折算值 ' + d.seal.conclusion.finalCompensated.toFixed(4) + '</div>' : '';
      return '<table><tr><th>#</th><th>类型</th><th>读数</th><th>温度</th><th>折算(20℃)</th><th>操作人</th><th>判定</th></tr>' + rows + '</table>' + seal +
        '<div class="row">' +
        '<button data-act="initial">录初测</button>' +
        '<button data-act="recheck">录复测</button>' +
        '<button class="secondary" data-act="revise">修订初测</button>' +
        '<button class="secondary" data-act="seal">封存</button></div>';
    }
    function bindActions(d) {
      const card = document.querySelector('[data-detail="' + d.id + '"]');
      card.querySelectorAll('[data-act]').forEach(btn => btn.onclick = async () => {
        try {
          const act = btn.dataset.act;
          if (act === 'seal') {
            const r = await api('/api/batches/' + d.id + '/seal', { method: 'POST', body: JSON.stringify({ operator: prompt('封存人') || '' }) });
            alert(r.duplicated ? '重复封存：沿用首次结果 ' + r.seal.id : '封存成功 ' + r.seal.id);
          } else {
            const value = prompt('读数'); if (value === null) return;
            const temperature = prompt('温度℃'); if (temperature === null) return;
            const operator = prompt('操作人'); if (!operator) return;
            const payload = { value: Number(value), temperature: Number(temperature), operator, point: prompt('测点（可空）') || undefined };
            const path = act === 'initial' ? 'initial' : act === 'recheck' ? 'recheck' : 'revise-initial';
            const r = await api('/api/batches/' + d.id + '/' + path, { method: 'POST', body: JSON.stringify(payload) });
            if (r.measurement && r.measurement.needsRecheck) alert('已转待复测：' + r.measurement.reasons.join('；'));
          }
        } catch (e) { alert(e.message); }
        await load();
      });
    }
    document.querySelector('#modelForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/models', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await load(); } catch (err) { alert(err.message); } };
    document.querySelector('#riggingForm').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target).entries()); if (f.nominal === '') delete f.nominal; else f.nominal = Number(f.nominal); try { await api('/api/models/' + f.modelId + '/riggings', { method: 'POST', body: JSON.stringify(f) }); e.target.reset(); await load(); } catch (err) { alert(err.message); } };
    document.querySelector('#openForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/batches', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await load(); } catch (err) { alert(err.message); } };
    document.querySelector('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}

const routes = [
  // 模型档案
  { method: "GET", pattern: /^\/api\/models$/, handler: async () => archive.listModels() },
  { method: "POST", pattern: /^\/api\/models$/, handler: async (req) => archive.registerModel(await body(req)), status: 201 },
  { method: "POST", pattern: /^\/api\/models\/([^/]+)\/riggings$/, handler: async (req, m) => archive.registerRigging({ ...(await body(req)), modelId: m[1] }), status: 201 },
  { method: "GET", pattern: /^\/api\/models\/([^/]+)\/riggings$/, handler: async (req, m) => archive.listRiggingsByModel(m[1]) },
  // 批次闭环
  { method: "POST", pattern: /^\/api\/batches$/, handler: async (req) => batches.openBatch(await body(req)), status: 201 },
  { method: "GET", pattern: /^\/api\/batches$/, handler: async () => batches.listBatches() },
  { method: "GET", pattern: /^\/api\/batches\/([^/]+)$/, handler: async (req, m) => {
      const batch = await batches.getBatch(m[1]);
      if (!batch) throw Object.assign(new Error("批次不存在"), { status: 404, code: "BATCH_NOT_FOUND" });
      return batch;
    } },
  { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/initial$/, handler: async (req, m) => batches.submitInitial(m[1], await body(req)), status: 201 },
  { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/recheck$/, handler: async (req, m) => batches.submitRecheck(m[1], await body(req)), status: 201 },
  { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/revise-initial$/, handler: async (req, m) => batches.reviseInitial(m[1], await body(req)) },
  { method: "POST", pattern: /^\/api\/batches\/([^/]+)\/seal$/, handler: async (req, m) => batches.seal(m[1], await body(req)) },
  // 当前统计（失效快照不计入）
  { method: "GET", pattern: /^\/api\/stats$/, handler: async () => batches.stats() },
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    for (const route of routes) {
      const match = url.pathname.match(route.pattern);
      if (match && req.method === route.method) {
        const result = await route.handler(req, match);
        return send(res, route.status || 200, result);
      }
    }
    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, err.status || 500, { error: err.code || "internal_error", message: err.message });
  }
});

server.listen(port, () => console.log(`古船帆索校准批次闭环 listening on http://localhost:${port}`));
