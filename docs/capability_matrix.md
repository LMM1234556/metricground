# MetricGround 当前能力与证据矩阵

> 当前基准日期：2026-10-11（v0.3.9 / Sites 版本13）
> 产品阶段：可用于面试演示和目标用户测试的 MVP，不是生产级企业数据平台。

## 产品定位

MetricGround 面向使用 Excel/CSV 完成常见经营分析的初级数据分析师，提供“数据画像—质量检查—口径确认—受控计算—结果验证”的人机协同工作流。公开受限试验中，明确意图优先规则，未匹配表达可交给 Qwen-Plus 规划；确定性程序负责读取、检查、关联、计算和验证，用户负责业务语义和高风险操作确认。

## 能力、证据与边界

| 能力 | 当前状态 | 可检查证据 | 当前边界 |
|---|---|---|---|
| CSV/XLSX 数据画像 | 已完成 | `verify-file-profile.mjs`、`verify-core-boundaries.mjs`、`verify-upload-boundaries.mjs` | 已限制 10 万行/200 列并拦截常见伪装与二进制文件；复杂合并单元格、多层表头仍未系统验证 |
| 数据质量检查 | 已完成基础规则 | `verify-quality-checks.mjs`、`verify-quality-impact.mjs` | 跨字段业务规则和企业自定义合法值域仍有限 |
| 受控清洗副本 | 已完成 | `verify-cleaning-workflow.mjs` | 只允许完全重复、指定字段缺失、无效日期三类白名单规则 |
| 指标口径合同 | 已完成 | `verify-metric-contract.mjs` | 通用“任意聚合量 / 任意聚合量”比例尚未实现 |
| 单指标受控计算 | 已完成 | `verify-controlled-execution.mjs`、`verify-core-boundaries.mjs`、`test:execution:mobile` | 浏览器确定性主计算 + DuckDB-WASM 独立 SQL 复算；已覆盖移动冷缓存模拟 4G，业务口径仍需人工确认 |
| 分组、趋势、Top N | 已完成 | `verify-business-analysis-core.mjs`、`verify-business-analysis.mjs` | 只支持结构化白名单聚合，不执行任意生成代码 |
| `AnalysisSpec` | 已完成 | `verify-agent-foundation.mjs` | 当前为项目内部协议，不是外部行业标准 |
| `TaskRun` 状态机与持久化 | 已完成 | `verify-agent-runtime.mjs`、`verify-task-persistence.mjs`、`verify-workspace-recovery.mjs` | D1 保存审计元数据，IndexedDB 保存当前浏览器工作区；跨设备仍需重传原始文件 |
| API 基础防护 | 已完成本地验收 | `verify-task-persistence.mjs` | D1 固定窗口限流、同源写入、请求体上限和安全头；不是企业级 WAF |
| 身份与 TaskRun 隔离 | 登录与匿名隔离均已线上验证 | 历史双账号自读 200、交叉读取 404；当前两个匿名会话自读 200、交叉读取 404、跨会话覆盖 409；缺少会话返回 401 | 当前临时免登录；Cookie 7 天有效，同浏览器配置共享身份，无匿名账号迁移、角色权限或团队空间 |
| D1 备份恢复 | 已完成本地演练 | `verify-d1-recovery.mjs`、运行时 SHA-256 清单 | 尚未验证远程 D1 的定时备份、保留策略和灾备时限 |
| 健康检查与日志 | 已部署并启用最小告警 | 匿名 `/api/health` 200；Web/D1 为 `ok`；结构化健康事件；每小时 Sites 状态与 Worker 错误检查；12 场景告警状态机演练进入 CI | 当前定时任务尚未调用健康接口做合成探测；真实通知送达仍需平台记录；无完整 APM、升级链和值班流程 |
| 双表/三表受控关联 | 已完成 | `verify-controlled-join.mjs`、`verify-multi-table-ui.mjs`、`verify-three-table-wizard.mjs` | 最多三表；等值单键/双字段复合键；`N:N` 默认禁止 |
| 关联金额对账 | 已完成常见金额字段 | `verify-join-reconciliation-ui.mjs` | 自动识别常见金额字段名；非常规字段名尚缺人工指定入口 |
| 证据包导出 | 格式1.3；自动回归与单条真实Qwen完整链路通过 | `verify-planning-provenance.mjs`、`verify-evidence-package.mjs`、`verify-evidence-download.mjs`；真实任务6cece52d审批前/后规划证据不变，报告/JSON同校验码；CI 38110914363 | 模型决策经参数校验，不是原始HTTP；历史缺失字段不补写；单条所有者链路不等于总体准确率；不含原始行、最多100组并标记截断；不是第三方审计 |
| 跨场景泛化回归 | 已完成自动化测试 | `evaluate-cross-scenarios.mjs`、`evaluate-workbench.mjs` | 自建订单/营销/库存小样本，不等同于真实企业泛化能力 |
| 自然语言路由与澄清 | 有限范围已验证 | `verify-intent-reliability.mjs` 24 用例；实际规划 API 15 用例；线上匿名探针 10 用例；新增页面交接断言 | 自建规则测试，不代表任意表达理解或模型准确率；关联风险需实际关联证据 |
| 本地/云模型降级 | 历史真实工具/API/网页链路完成；受限云试验开启 | `verify-cloud-model-trial.mjs`、`verify-hosted-cloud-trial.ps1`；真实任务保存cloud-agent/Qwen元数据、最终口径、计算与复核 | 自建探针和少量网页任务不是盲测准确率；v0.3.8保存的是系统候选计划，不能反推模型工具原决策 |
| 云模型控费 | 出站门禁与 SQL/fetch 回归完成 | `verify-model-cost-policy.mjs`；累计20次、每问题2次、输出512 Token、输入24KB | 请求量上限不是金额硬上限；本地/公网账本分开；免费保护与账单需控制台核实 |
| 新人引导自动化验收 | 已完成 | `verify-novice-guide.mjs` 24/24；5 份测试文件均可读取 | 只能证明流程闭环，不代表真实新人理解和独立完成 |
| 正式目标用户研究 | 首轮自由表达材料完成，尚未开展 | `evaluation/user_test_round1/`、五份参与者ZIP与独立参考值；先P01/P02各一次原话问题，额度准备时剩5 | 开发者设计的目标卡不是独立外部盲测；必须先记录首次参与者原话并冻结版本，规则/模型/兜底及提示后完成分开报告 |
| 远程仓库与公开入口 | 已发布匿名新人测试环境 | 公开GitHub；Sites13、v0.3.9；完整CI及真实Qwen格式1.3完整链路通过 | 项目所有者链路、模拟回归、首次参与者研究分别报告；正式用户研究未完成 |
| 数据库、权限、多人协作 | 部分完成 | D1 持久化、幂等并发控制、条件式所有者隔离 | 无任务历史 UI、角色权限、团队空间和企业治理，不应描述为企业级数据平台 |

## 面试时可以陈述的结论

- 这是一个具备结构化计划、工具调用、人工审批、确定性执行和结果验证的 Agent MVP，不是单纯聊天界面。
- 已验证范围覆盖陌生 Excel/CSV 的基础画像、质量检查、四类指标、分组/趋势/Top N、最多三表关联和证据导出。
- 系统能阻止口径不完整、字段不存在、`N:N`、数据版本漂移和关联金额不守恒等危险路径。
- 尚不能声称已经证明真实用户可用性、所有行业数据泛化能力或生产级治理能力。

## 下一阶段

1. 先邀请两名首次参与者按 `evaluation/user_test_round1/host_protocol.md` 顺序测试；其余三份包等待额度与首轮反馈再安排；
2. 若托管任务出现真实故障或恢复通知，保留平台通知、时间窗口和对应 Worker 日志；健康轮次按设计静默，平台当前不提供运行历史，不能伪造送达证据；
3. 根据用户失败点决定是否补通用比例、非常规金额字段指定和复杂 Excel 支持。
4. 模型已受限接入；先固定v0.3.9并在系统回答前记录参与者自己的问法，审阅原决策与程序调整。按真实source分开统计规则、模型和额度兜底，修复回测不回填首次结果。
