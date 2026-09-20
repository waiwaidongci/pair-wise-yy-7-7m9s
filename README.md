# 古船模型帆索校准 · 环境补偿与批次封存闭环

运行：

```bash
npm start
```

访问 `http://localhost:3038`。数据保存在 `data/model-rigging-calibration.json`（旧版 `items` 档案会自动迁移为模型档案）。

## 模块划分

- `src/modelArchive.js` — 模型档案：建档、查询
- `src/compensation.js` — 补偿规则：20℃ 折算、温度越界与相邻漂移判定
- `src/recordStore.js` — 记录存储：批次、测量、封存、快照、统计；所有读写经串行队列，`检查-写入`同事务，并发开批不会双双落库
- `server.js` — HTTP 路由与页面

## 补偿规则

- 折算公式：`v20 = 实测值 × (1 + α × (20 − T))`，α 按帆索材料取值（蜡线 0.004、棉线 0.003、金属索 0.0012、默认 0.002）
- 测点温度越界 5–35℃，或相邻两次折算值偏差超 8%，该读数不合格，批次转「待复测」
- 规则见 `GET /api/compensation/rules`

## 闭环流程

1. `POST /api/models` 建档
2. `POST /api/batches` 开批：一个船台同时仅允许一个开放批次，重复或并发开批返回 **409 且不落库**
3. `POST /api/batches/:id/initial` 提交初测（测点、温度、读数、操作人），按 20℃ 折算
4. `POST /api/batches/:id/remeasure` 复测：**须换人**（与上一条测量操作人不同），否则 409
5. `POST /api/batches/:id/seal` 封存：须**连续两次折算值合格**；重复封存返回 200 并沿用首次结论
6. `PATCH /api/batches/:id/initial` 修订初测：批次、结论和统计**立即失效**，旧快照保留在 `snapshots` 但不计入当前统计，船台随即释放可重新开批

## 统计

`GET /api/stats` 只统计有效批次（open / pending_remeasure / sealed）；失效批次与快照不计入。快照经 `GET /api/snapshots` 查询。
