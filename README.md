# 古船模型帆索校准 · 环境补偿与批次封存闭环

在原有校准台基础上升级为闭环管理：**模型档案、补偿规则、记录存储三块独立实现**，由批次服务编排。

## 结构

| 模块 | 职责 |
| --- | --- |
| `src/modelArchive.js` | 模型档案与索具测点登记（静态档案，不管测量） |
| `src/compensationRules.js` | 环境补偿规则：20℃ 折算、5–35℃ 温度窗口、相邻读数 8% 阈值、合格判定 |
| `src/recordStore.js` | 记录存储：JSON 落盘、事务串行化（读-改-写一把锁，抛错不落库） |
| `src/batchService.js` | 批次闭环编排：开批 → 初测 → 复测 → 封存 → 统计 |
| `server.js` | HTTP 层与页面，只做路由和参数校验 |

## 闭环规则

- **一船台一开放批次**：同一 `benchId` 存在未封存批次时，重复或并发开批返回 `409 BATCH_CONFLICT`，且不落库。
- **初测**：提交读数、温度、测点，读数按 20℃ 折算（`raw / (1 + 0.002·(T−20))`）。
- **转待复测**：测点温度越界 5–35℃，或与上一读数折算值相差超 8%。
- **复测换人**：复测操作人不得与上一次测量相同，否则 `409 SAME_OPERATOR`。
- **封存**：连续两次折算值合格（相对标称值偏差 ≤2%）才允许封存；重复封存沿用首次结果（幂等）。
- **修订初测**：批次、结论和统计立即失效；旧快照（封存结论 + 全部测量）保留在 `invalidatedSnapshots`，不计入当前统计；修订后的初测作为新起点重新进入闭环。

## 运行

```bash
npm start          # http://localhost:3038，数据在 data/calibration-batches.json
npm test           # 端到端闭环测试（真实起服务，独立临时数据文件）
```

## API

- `POST /api/models`、`POST /api/models/:id/riggings` — 建档与测点登记
- `POST /api/batches` — 开批（409 冲突）
- `POST /api/batches/:id/initial` / `recheck` / `revise-initial` / `seal`
- `GET /api/batches`、`GET /api/batches/:id` — 批次与测量明细
- `GET /api/stats` — 当前统计（仅计有效批次的封存结论）

> 旧版数据文件 `data/model-rigging-calibration.json` 为升级前遗留，新系统不再读写。
