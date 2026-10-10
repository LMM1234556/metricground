# v0.3.5 受限公网模型试验与 Worker 修复

日期：2026-10-10。公开站点：https://metricground.chirpyseed1.chatgpt.site。

## 真实失败、定位与修复

- 初次在 Sites 版本 8 开启云端试验（环境修订 4），2026-10-10T09:21:11.5722853Z 的首个规划返回 `rule-fallback`，原因 `dashscope: MODEL_REQUEST_FAILED`，不是模型成功。
- 随即关闭云端并部署环境修订 5，保留计数，不通过反复付费重试诊断。
- 用真实 workerd + 合成上游、无密钥测试复现：原 `redirect:error` 抛出 TypeError，成功出站次数为零；AbortSignal 组合可用，绑定/不绑定 fetch 都失败，因此不是简单的 fetch 绑定问题。
- 改成 `redirect:manual`，显式拒绝所有 3xx，禁止跟随 Location。修改后两个正常请求成功，一次模拟重定向被拒绝，合成上游只收到三次请求，没有访问重定向目的地。此测试不产生模型费用。
- [Cloudflare 官方说明](https://developers.cloudflare.com/workers/runtime-apis/request/)提醒跟随重定向可能转发 Authorization，建议采用 manual 和自定义策略。本文“不兼容 error”的判断来自实际运行时复现，不能将文档列出的支持情况当作已验证运行行为。
- 网络失败与调用摘要持久化失败分开处理，计数均保留；新增只读健康摘要查看累计请求数与已知 Token 用量，不发健康探测模型请求。

## 源码与发布

- 功能提交：`d2c11b1098eeae25998de0796571e799b0b7eec1`。
- [完整 CI 38041683321](https://github.com/LMM1234556/metricground/actions/runs/38041683321)：静态门与浏览器回归 success；本地完整静态门通过。新增真实 Worker 运行时回归纳入静态门。
- Sites 版本 9，应用版本 0.3.5；托管源码 `ba6291dc26fac6d0a5f55e0d0e97502825c34ea8`，官方源码流程回读核实。
- 构建包 SHA-256：`ea2707f1880413f640de53afb40376dbfbfff81950fb67da1315982d2dba6559`。
- 先以环境修订 5 发布关闭态：`appgdep_6aca079c0e808191bc2f3352c772760c`，succeeded；确认 D1 reservedRequests=1、remainingRequests=19，旧失败没有被重新部署清零。
- 再以环境修订 6 开启受限试验：`appgdep_6aca0826181c8191a4eba2a399c563c5`，succeeded。保留 public、匿名会话、Secret、qwen-plus、cloud-only 和累计20次上限，不修改密钥、不扩额度。

## 公网 API 与真实云模型探针

脚本：`frontend/scripts/verify-hosted-cloud-trial.ps1`。该脚本最多执行一个自建问题，先检查版本、开关和至少两次剩余额度；未就绪时不发模型请求。

2026-10-10T09:41:09.6310672Z：

- 问题：每个地方带来的钱分别是多少。
- 合成画像：order_id、amount、region，3 行；不含原始数据行。
- source=`cloud-agent`，provider=`dashscope`，model=`qwen-plus`；2 个工具步骤，接口耗时 3914 ms。
- analysisType=`group_compare`，groupField=`region`，valueField=`amount`。
- action=`clarify`，要求人工确认聚合口径，没有自动执行数字计算。
- 供应商/SDK 报告 inputTokens=1183、outputTokens=43，合计1226 Token；未核对账单，不能据此声称零费用。
- D1 预占从1增至3，记录数从1增至3；remainingRequests=17。knownInputTokens=1183、knownOutputTokens=43、unknownUsageCalls=1。未知用量调用是先前失败，不能按零 Token 或无计费处理。

之后十个线上确定性规划探针与双会话隔离复测通过。明确意图仍优先使用规则，不能因为云端开关开启就把这些规则结果算成模型准确率。

## 尚未完成的验收

以上验证了公网 API → D1 控费预占 → 真实云模型工具调用 → 安全计划/澄清 → 用量摘要；还没有本轮真实网页上传 → 模型卡片 → 人工批准 → 确定性计算 → DuckDB → 下载的完整证据。

当前没有可直接控制用户浏览器的工具。交给用户在网页完成一轮操作，不把 API 通过冒充浏览器端到端通过；过去 CI 中的页面与确定性执行回归作为不同证据保留。

建议手工第一步：上传已有 `orders_profile_sample.csv`，提问“给我看一下这份表能干什么”，核对卡片显示 dashscope/qwen-plus/2步，并截取不含账号或密钥的卡片。先不连续重复发送。后续再确认商品金额字段和数据范围，完成审批、计算、独立复核与报告。

这是一个自建公网探针，不是独立盲测、真实新人研究或生产级模型准确率；累计20次仍是 HTTP 请求上限，不是人民币硬上限。`qwen-plus` 免费额度用完即停保护必须保留。
