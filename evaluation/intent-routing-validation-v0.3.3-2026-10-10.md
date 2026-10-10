# v0.3.3 意图路由与线上复测记录

验证日期：2026-10-10。公开地址：https://metricground.chirpyseed1.chatgpt.site。

本轮验证规则路由、字段绑定与页面交接，不评估真实大模型准确率，也不替代目标用户研究。所有问题与数据均为自建；没有无指导用户测试或盲测准确率声明。

## 可复现来源

- 功能与测试仓库提交：`0d58121203aab314c6d91b31ad20d225c9784934`。
- [完整 CI 38034536024](https://github.com/LMM1234556/metricground/actions/runs/38034536024)：Static quality gate 与 Browser regression 均为 success。
- Sites 版本：7；包版本：0.3.3；运行时环境修订：2；公开与匿名会话配置保持不变。
- 托管源码提交：`915d03cdbced89e3f2d02f6dac48059ecc6ac422`，官方源码流程回读核实。
- 保存版本：`appgprj_6ac7bf4b8d84819195312b901d476b57~appgver_4bf3963828108191aded16dbc086b7cb`。
- 发布记录：`appgdep_6ac9ea572bc88191b9a2881d148a33ad`，状态 succeeded。
- 发布包 SHA-256：`3ada3e04717e7afcecd4456e68d595cc5fa7fddb4a7331d6500f12cbf029ff8e`。Windows 使用官方构建预处理脚本与原生 tar 完成打包；没有改用远程未验证构建。

## 验证层次

| 层次 | 已执行证据 | 证明范围 |
|---|---|---|
| 纯逻辑 | `npm run test:intent`：24 个路由用例、8 组策略检查、5 组执行检查通过 | 意图、共享策略、最大/最小排序、缺字段配置；不是 37 个独立用户问题 |
| 实际接口 | `npm run test:intent:api`：15 个用例通过 | 匿名会话下实际 `/api/agent/plan`，source 为 policy-router |
| 浏览器 | `test:agent` 中新增 5 个交接断言通过，完整 CI 浏览器门禁通过 | 计数、排名、缺编号空选择、预测拒答、多表关联交接，以及原有计算/恢复/隔离回归 |
| 线上规划 | `scripts/verify-hosted-intent-routing.ps1`：10 个用例通过 | 公网匿名接口与字段绑定；2026-10-10T07:34:29.6510614Z；version=0.3.3，source=policy-router |
| 线上隔离 | `scripts/verify-hosted-anonymous-session.ps1` 通过 | 2026-10-10T07:34:37.8859171Z；无会话 401，匿名规划 200，自读 200、双向交叉读取 404、跨会话覆盖 409 |

本轮未新增公网浏览器全链路或真实移动设备验收；完整浏览器测试在 GitHub 的生产构建预览执行。v0.3.2 的真实设备证据为历史记录，不能冒充本轮新测试。

## 修复前后

- “帮我算一下有多少笔不同的订单”：正确进入去重计数口径，不要求固定模板表达。
- “哪个地区的订单金额最多”：保留 Top N 任务与经营分析页面；金额边界仍需确认，最大/最小默认只展示一个对象。
- “预测下个月销售额”：unsupported，不被金额澄清策略改成可计算任务。
- 缺客户编号、cost、price 或渠道：保留空字段和 clarify；不使用 order_id、amount、region 替代用户所问对象。
- “为什么表的行数比订单数多”：根据画像的行数和唯一值检查前提；一致时明确未发现差异，不能默认归因于重复错误。
- “关联后金额多了一倍”：跳转多表关联查看膨胀与来源行对账；单表画像不足以证明根因，不自动批准危险求和。

## 失败与修正也保留

[CI 38030464736](https://github.com/LMM1234556/metricground/actions/runs/38030464736) 中，15 个 API 用例及新增交接断言通过，但后续测试的 IndexedDB 清理返回 blocked，因此整次回归失败。修改专用 localhost 测试浏览器清理：先离开应用释放连接，再清理该源 IndexedDB，回到应用；不对用户浏览器执行清理，也不通过忽略错误让测试通过。修正后完整 CI 38034536024 成功。

## 重跑方式

在 `frontend` 中运行 `npm run test:intent`。启动生产预览与专用调试浏览器后运行 `npm run test:intent:api`、`npm run test:agent`。GitHub CI 执行完整门禁。

PowerShell 7 线上探针：

```powershell
./scripts/verify-hosted-intent-routing.ps1
./scripts/verify-hosted-anonymous-session.ps1
```

前一个只发送合成画像并读取计划；后一个会创建两个明确命名的匿名隔离探针 TaskRun，不上传原始文件。

## 当前能力边界与下一阶段

在线探针证实 source=policy-router。可选 Ollama/云模型适配器代码不等于当前公开环境已启用大模型，也不能从自建路由用例推出任意自然语言准确率。

下一阶段需要配置可达模型服务，并用未参与规则开发的真实口语、含歧义问法、缺字段、重复统计和关联风险问题比较：意图正确率、必要澄清率、错误字段绑定率、危险执行拦截率、端到端任务完成率及延迟。企业口径、关联语义和清洗审批仍保留人工确认；模型不能直接编造数字。
