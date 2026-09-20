// 模型档案：只负责船模与索具测点的静态档案，不涉及测量与批次。
// 每条索具（测点）挂在某个模型下，档案号是后续批次、测量记录的关联键。

let counter = 0;

function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function createModelArchive() {
  const models = new Map(); // modelId -> model
  const riggings = new Map(); // riggingId -> rigging

  return {
    /** 建档：登记一件古船模型 */
    registerModel(input = {}) {
      if (!input.code || !String(input.code).trim()) {
        throw Object.assign(new Error("模型编号不能为空"), { code: "VALIDATION" });
      }
      const model = {
        id: nextId("MDL"),
        code: String(input.code).trim(),
        shipType: input.shipType || "",
        scale: input.scale || "",
        riggingMaterial: input.riggingMaterial || "",
        owner: input.owner || "",
        createdAt: new Date().toISOString(),
      };
      models.set(model.id, model);
      return structuredClone(model);
    },

    /** 在模型下登记索具测点 */
    registerRigging(input = {}) {
      if (!models.has(input.modelId)) {
        throw Object.assign(new Error("模型不存在"), { code: "MODEL_NOT_FOUND" });
      }
      if (!input.point || !String(input.point).trim()) {
        throw Object.assign(new Error("测点名称不能为空"), { code: "VALIDATION" });
      }
      const rigging = {
        id: nextId("RIG"),
        modelId: input.modelId,
        point: String(input.point).trim(),
        position: input.position || "",
        nominal: input.nominal ?? null, // 标称值（20℃基准），可选
        createdAt: new Date().toISOString(),
      };
      riggings.set(rigging.id, rigging);
      return structuredClone(rigging);
    },

    getModel(id) {
      const model = models.get(id);
      return model ? structuredClone(model) : null;
    },

    getRigging(id) {
      const rigging = riggings.get(id);
      return rigging ? structuredClone(rigging) : null;
    },

    listRiggingsByModel(modelId) {
      return [...riggings.values()]
        .filter((r) => r.modelId === modelId)
        .map((r) => structuredClone(r));
    },

    listModels() {
      return [...models.values()].map((m) => structuredClone(m));
    },
  };
}
