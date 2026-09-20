// 记录存储：批次、测量、封存、快照与统计的持久化（独立模块）
// 所有读写经同一队列串行执行，"检查-写入"在同一事务内完成：
// 并发或重复开批时，后到的请求在锁内看到已存在的开放批次，返回冲突且不落库。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReading, toBaseTemp } from "./compensation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "..", "data", "model-rigging-calibration.json");

export const STATUS = { OPEN: "open", PENDING: "pending_remeasure", SEALED: "sealed", VOID: "void" };
export const isActive = batch => batch.status === STATUS.OPEN || batch.status === STATUS.PENDING;

let db = null;
let queue = Promise.resolve();

// 写事务：fn 返回带 error 字段的结果时不落库
export function transact(fn) {
  const run = queue.then(async () => {
    const d = await load();
    const result = await fn(d);
    if (!result?.error) await persist(d);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

// 读也走同一队列，保证看到一致的顺序
export function query(fn) {
  const run = queue.then(async () => fn(await load()));
  queue = run.catch(() => {});
  return run;
}

async function load() {
  if (db) return db;
  if (!existsSync(dbPath)) {
    db = { models: [], batches: [], snapshots: [] };
    await mkdir(dirname(dbPath), { recursive: true });
    await persist(db);
    return db;
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  db = {
    models: raw.models || raw.items || [], // 兼容旧版 items 档案
    batches: raw.batches || [],
    snapshots: raw.snapshots || []
  };
  return db;
}

async function persist(d) {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(d, null, 2));
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function invalid(message) {
  return { error: "invalid_input", message };
}

function validateReadingInput(input) {
  if (!input || !String(input.point ?? "").trim()) return invalid("测点必填");
  if (!Number.isFinite(Number(input.temp))) return invalid("温度必须为数字");
  if (!Number.isFinite(Number(input.value))) return invalid("读数必须为数字");
  if (!String(input.operator ?? "").trim()) return invalid("操作人必填");
  return null;
}

function buildReading(d, batch, input, kind) {
  const problem = validateReadingInput(input);
  if (problem) return problem;
  const model = d.models.find(m => m.code === batch.modelCode || m.id === batch.modelCode);
  const prev = batch.measurements[batch.measurements.length - 1];
  const temp = Number(input.temp);
  const converted = toBaseTemp(Number(input.value), temp, model?.riggingMaterial);
  const { qualified, flags } = evaluateReading({ temp, converted, prevConverted: prev?.converted });
  return {
    id: newId("R"),
    kind,
    point: String(input.point).trim(),
    temp,
    value: Number(input.value),
    operator: String(input.operator).trim(),
    converted,
    qualified,
    flags,
    at: new Date().toISOString()
  };
}

function findBatch(d, id) {
  return d.batches.find(b => b.id === id);
}

// 开批：一个船台同时仅允许一个开放批次
export function openBatch(input) {
  return transact(d => {
    if (!String(input.station ?? "").trim()) return invalid("船台必填");
    if (!String(input.modelCode ?? "").trim()) return invalid("模型必填");
    const model = d.models.find(m => m.code === input.modelCode || m.id === input.modelCode);
    if (!model) return { error: "model_not_found", message: "模型不存在" };
    const existing = d.batches.find(b => b.station === input.station && isActive(b));
    if (existing) return { error: "station_busy", message: `船台 ${existing.station} 已有开放批次 ${existing.id}`, existing };
    const batch = {
      id: newId("B"),
      station: String(input.station).trim(),
      modelCode: model.code || model.id,
      status: STATUS.OPEN,
      createdAt: new Date().toISOString(),
      initial: null,
      measurements: [],
      conclusion: null,
      sealedAt: null
    };
    d.batches.unshift(batch);
    return { batch };
  });
}

// 提交初测：越界或相邻漂移超 8% 自动转待复测
export function addInitial(batchId, input) {
  return transact(d => {
    const batch = findBatch(d, batchId);
    if (!batch) return { error: "not_found", message: "批次不存在" };
    if (!isActive(batch)) return { error: "batch_not_active", message: "批次已封存或已失效" };
    if (batch.initial) return { error: "initial_exists", message: "初测已提交，修订请走修订接口" };
    const reading = buildReading(d, batch, input, "initial");
    if (reading.error) return reading;
    batch.initial = reading;
    batch.measurements.push(reading);
    if (!reading.qualified) batch.status = STATUS.PENDING;
    return { batch, reading };
  });
}

// 复测：必须与上一条测量换人
export function addRemeasure(batchId, input) {
  return transact(d => {
    const batch = findBatch(d, batchId);
    if (!batch) return { error: "not_found", message: "批次不存在" };
    if (!isActive(batch)) return { error: "batch_not_active", message: "批次已封存或已失效" };
    if (!batch.initial) return { error: "no_initial", message: "请先提交初测" };
    const prev = batch.measurements[batch.measurements.length - 1];
    if (prev && prev.operator === String(input.operator ?? "").trim()) {
      return { error: "operator_must_change", message: "复测须换人，操作人不能与上一条测量相同" };
    }
    const reading = buildReading(d, batch, input, "remeasure");
    if (reading.error) return reading;
    batch.measurements.push(reading);
    batch.status = reading.qualified ? STATUS.OPEN : STATUS.PENDING;
    return { batch, reading };
  });
}

// 封存：需连续两次折算值合格；重复封存沿用首次结果
export function sealBatch(batchId, input = {}) {
  return transact(d => {
    const batch = findBatch(d, batchId);
    if (!batch) return { error: "not_found", message: "批次不存在" };
    if (batch.status === STATUS.SEALED) return { batch, conclusion: batch.conclusion, reused: true };
    if (batch.status === STATUS.VOID) return { error: "batch_void", message: "批次已失效，不能封存" };
    const lastTwo = batch.measurements.slice(-2);
    if (!(lastTwo.length === 2 && lastTwo.every(r => r.qualified))) {
      return { error: "not_ready", message: "须连续两次折算值合格才可封存" };
    }
    const conclusion = {
      result: "合格",
      batchId: batch.id,
      station: batch.station,
      modelCode: batch.modelCode,
      readings: batch.measurements.length,
      finalConverted: lastTwo[1].converted,
      sealedBy: input.operator ? String(input.operator).trim() : null,
      sealedAt: new Date().toISOString()
    };
    batch.conclusion = conclusion;
    batch.status = STATUS.SEALED;
    batch.sealedAt = conclusion.sealedAt;
    return { batch, conclusion };
  });
}

// 修订初测：批次、结论和统计立即失效；旧快照保留但不计入当前统计
export function reviseInitial(batchId, input) {
  return transact(d => {
    const batch = findBatch(d, batchId);
    if (!batch) return { error: "not_found", message: "批次不存在" };
    if (!batch.initial) return { error: "no_initial", message: "批次尚无初测" };
    if (batch.status === STATUS.VOID) return { error: "batch_void", message: "批次已失效" };
    const problem = validateReadingInput(input);
    if (problem) return problem;
    d.snapshots.unshift({
      id: newId("S"),
      at: new Date().toISOString(),
      reason: "initial_revised",
      countedInStats: false,
      batch: JSON.parse(JSON.stringify(batch))
    });
    batch.status = STATUS.VOID;
    batch.conclusion = null;
    batch.voidReason = "initial_revised";
    batch.revisedInitial = {
      point: String(input.point).trim(),
      temp: Number(input.temp),
      value: Number(input.value),
      operator: String(input.operator).trim(),
      at: new Date().toISOString()
    };
    return { batch };
  });
}

export function listBatches(station) {
  return query(d => (station ? d.batches.filter(b => b.station === station) : d.batches));
}

export function getBatch(id) {
  return query(d => findBatch(d, id) || null);
}

export function listSnapshots() {
  return query(d => d.snapshots);
}

// 当前统计只计有效批次；失效批次与旧快照不计入
export function stats() {
  return query(d => {
    const current = d.batches.filter(b => b.status !== STATUS.VOID);
    const count = status => current.filter(b => b.status === status).length;
    return {
      [STATUS.OPEN]: count(STATUS.OPEN),
      [STATUS.PENDING]: count(STATUS.PENDING),
      [STATUS.SEALED]: count(STATUS.SEALED),
      void: d.batches.length - current.length,
      snapshots: d.snapshots.length,
      total: current.length
    };
  });
}
