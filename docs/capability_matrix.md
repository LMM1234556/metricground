# MetricGround 当前能力与证据矩阵

> 当前基准日期：2026-10-10（v0.3.2）
> 产品阶段：可用于面试演示和目标用户测试的 MVP，不是生产级企业数据平台。

## 产品定位

MetricGround 面向使用 Excel/CSV 完成常见经营分析的初级数据分析师，提供“数据画像—质量检查—口径确认—受控计算—结果验证”的人机协同工作流。模型负责理解、规划和澄清；确定性程序负责读取、检查、关联、计算和验证；用户负责确认业务语义和高风险操作。

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
| 证据包导出 | 已完成 | `verify-evidence-package.mjs` | 不含原始数据行；尚无服务端历史审计库 |
| 跨场景泛化回归 | 已完成自动化测试 | `evaluate-cross-scenarios.mjs`、`evaluate-workbench.mjs` | 自建订单/营销/库存小样本，不等同于真实企业泛化能力 |
| 本地/云模型降级 | 已完成 | `verify-model-providers.mjs` | 云模型需要用户主动配置；模型不接收原始明细行 |
| 新人引导自动化验收 | 已完成 | `verify-novice-guide.mjs` 24/24；5 份测试文件均可读取 | 只能证明流程闭环，不代表真实新人理解和独立完成 |
| 正式目标用户研究 | 进行前准备完成 | 测试方案、观察表和 5 份合成文件已完成；项目所有者手工走通 3/5 份 | 尚无 5 名独立目标用户数据，不能声称“新人测试通过” |
| 远程仓库与公开入口 | 已发布匿名新人测试环境 | 公开 GitHub；Sites 版本 6、包版本 v0.3.2；匿名规划与双会话隔离线上通过；显式匿名模式完整 CI 通过，含压力后首次接口响应 | 不代表真实目标用户测试完成；没有生产 SLA 或生产级模型准确率保证 |
| 数据库、权限、多人协作 | 部分完成 | D1 持久化、幂等并发控制、条件式所有者隔离 | 无任务历史 UI、角色权限、团队空间和企业治理，不应描述为企业级数据平台 |

## 面试时可以陈述的结论

- 这是一个具备结构化计划、工具调用、人工审批、确定性执行和结果验证的 Agent MVP，不是单纯聊天界面。
- 已验证范围覆盖陌生 Excel/CSV 的基础画像、质量检查、四类指标、分组/趋势/Top N、最多三表关联和证据导出。
- 系统能阻止口径不完整、字段不存在、`N:N`、数据版本漂移和关联金额不守恒等危险路径。
- 尚不能声称已经证明真实用户可用性、所有行业数据泛化能力或生产级治理能力。

## 下一阶段

1. 邀请 5 名目标用户进行无指导任务测试；
2. 若托管任务出现真实故障或恢复通知，保留平台通知、时间窗口和对应 Worker 日志；健康轮次按设计静默，平台当前不提供运行历史，不能伪造送达证据；
3. 根据用户失败点决定是否补通用比例、非常规金额字段指定和复杂 Excel 支持。
