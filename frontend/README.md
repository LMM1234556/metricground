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

- 外部数据库连接、角色权限、团队空间和多人协作；TaskRun 持久化与条件式所有者隔离已完成本地验收；
- 通用“聚合量 / 聚合量”比例；
- 非常规金额字段名的人工对账指定入口；
- 正式目标用户可用性研究；公开演示部署的当前状态以根目录交付记录为准。

## 临时匿名新人测试

公开测试部署同时设置 `METRICGROUND_REQUIRE_AUTH=false` 与 `METRICGROUND_ANONYMOUS_SESSIONS=true`。页面先调用 `/api/session`，服务端签发 HttpOnly、SameSite=Lax、HTTPS Secure 的随机会话 Cookie；核心 API 缺少合法会话时拒绝请求。TaskRun 按该匿名会话隔离，匿名限流仍按 IP 计算。

匿名 Cookie 有效期为 7 天；同一浏览器配置中的多个标签页共享身份。清除浏览器数据、Cookie 过期或恢复强制登录后，匿名记录不能按账号找回，也不会自动迁移。因此参与者应在结束前下载报告。原有登录账号的 TaskRun 所有者哈希保持兼容。

测试结束后设置 `METRICGROUND_REQUIRE_AUTH=true`、`METRICGROUND_ANONYMOUS_SESSIONS=false` 并重新部署。同一站点保持公开时，访客仍可打开首页，但核心 API 要求登录。不要把两个开关都关闭的本地开发配置部署到公开环境。

验证匿名会话初始化、刷新稳定性、双向读取隔离及跨会话写入拒绝：

```powershell
npm run test:anonymous-isolation -- --require-anonymous
```

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
