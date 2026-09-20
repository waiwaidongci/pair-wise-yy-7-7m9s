// 模型档案：古船模型建档与查询（独立模块，存储事务复用记录存储的串行队列）

import { newId, query, transact } from "./recordStore.js";

const ARCHIVE_FIELDS = ["code", "shipType", "scale", "mastCount", "riggingMaterial", "owner", "dueDate"];

export function listModels() {
  return query(d => d.models);
}

export function createModel(input) {
  return transact(d => {
    if (!String(input.code ?? "").trim()) return { error: "invalid_input", message: "模型编号必填" };
    const code = String(input.code).trim();
    if (d.models.some(m => m.code === code)) return { error: "model_exists", message: `模型 ${code} 已存在` };
    const model = { id: newId("M"), createdAt: new Date().toISOString() };
    for (const field of ARCHIVE_FIELDS) {
      if (input[field] !== undefined && input[field] !== "") model[field] = input[field];
    }
    model.code = code;
    if (model.mastCount !== undefined) model.mastCount = Number(model.mastCount);
    d.models.unshift(model);
    return { model };
  });
}
