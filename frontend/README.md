# MetricGround 前端

本目录包含 MetricGround 的 React/TypeScript 工作台、Agent 规划接口、浏览器本地确定性主计算引擎、DuckDB-WASM 独立 SQL 复核和端到端验证脚本。产品定位、完整能力和边界以仓库根目录的 [`README.md`](../README.md) 与 [`docs/capability_matrix.md`](../docs/capability_matrix.md) 为准。

## 当前能力摘要

- 本地读取 CSV/XLSX，执行画像、质量检查和受控清洗；
- 生成指标口径合同，执行计数、金额、平均、条件比例、分组、趋势和 Top N；
- 使用 `AnalysisSpec` 与 `TaskRun` 记录计划、人工确认、工具调用和验证；
- 支持最多三表、单键或双字段复合键的 `left/inner join`，默认阻止 `N:N`；
- 对常见金额字段执行来源行级对账，未守恒字段不能继续求和或求平均；
- 导出不含原始明细行的 Agent 证据包；
- 模型只接收字段画像和质量摘要，最终数字由白名单确定性工具计算。
- 关键结果必须再通过 DuckDB-WASM 独立复算；引擎版本、数据版本、SQL 和逐项勾稽进入 TaskRun 证据。

## 尚未完成

- 数据库连接、账户权限、任务持久化和多人协作；
- 通用“聚合量 / 聚合量”比例；
- 非常规金额字段名的人工对账指定入口；
- 公开部署和正式目标用户可用性研究。

## 本地运行

要求 Node.js 22+、Ollama，以及本地模型 `qwen3:8b`。

```powershell
ollama run qwen3:8b
npm install
npm run dev
```

浏览器打开 `http://localhost:5173/`。可通过环境变量 `OLLAMA_BASE_URL` 和 `OLLAMA_MODEL` 更换本地兼容服务或模型。

## 验证

```powershell
npm run lint
npm run build
npm run test:core
npm run test:quality
npm run test:cleaning
npm run test:metric
npm run test:execution
npm run test:analysis
npm run test:analysis:e2e
npm run test:join
npm run test:join:e2e
npm run test:join:reconciliation
npm run test:join:three-table
npm run test:agent:runtime
npm run test:evidence
npm run test:scenarios
```

浏览器回归脚本需要先打开启用远程调试端口 `9224` 的 Chromium/Edge。完整验证入口与边界说明见仓库根 README。
