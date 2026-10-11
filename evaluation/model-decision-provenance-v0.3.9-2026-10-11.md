# 模型工具决策与程序调整验收（v0.3.9）

## 真实问题与来源检查

- 用户任务 `task_21045983-60d8-4b81-a5cf-d902a88f8826` 的报告/JSON均为格式1.2，重新计算校验和 `614709427c70ed76` 通过；源CSV与数据版本匹配，独立分组复算得到华南288.5、华东189.8、华北0，全部与DuckDB相同。
- 文件记录cloud-agent/dashscope/qwen-plus、2步、1次尝试、3227ms、输入1413/输出33 Token；三项风险均为kept，人工审批与完成状态完整。
- API代码实际将模型工具决策传给planFromDecision，再运行enforcePolicyGuards和validatePlanFields；v0.3.8的proposal捕获的是最终系统候选计划。字段可以由程序补齐，置信度和完整步骤由程序设置，因此此前“模型原始提案”表述过强。

## 变更与验证

- 新增compileModelPlan共享处理流程：先深拷贝工具决策，再依次编译、策略约束、字段校验，记录各阶段变化字段及前后值。
- TaskRun深拷贝modelDecision/planAdjustments；报告和格式1.3 JSON分别展示模型决策、程序变化、系统候选计划和最终AnalysisSpec。历史缺失值不回填，规则路线记录为不适用。
- 真实SDK配合模拟模型依次调用inspectDataset与submitAnalysisPlan，证明未绑定金额仍为空，程序默认amount单独记录；策略改为clarify、非法字段被清空、类型调整和人工改为去重计数均有独立断言。
- 浏览器门禁执行规则路线和模拟模型响应路线，检查原决策空值、程序补齐、相同报告/JSON快照、835字符DuckDB SQL、聚合结果、D1持久化与刷新恢复。模拟响应标记synthetic-browser-mock，未调用真实平台。
- 完整CI 38110914363：静态质量门与浏览器回归全部success。

## 发布

- GitHub功能提交：eb90c7925ccbd04148479a6534298d5eec93c371。
- Sites源码提交：f60045900e4e003fc7d03f391f9b5be740546bff。
- Sites版本13：appgprj_6ac7bf4b8d84819195312b901d476b57~appgver_e02296900a548191a2e2a59089486cea。
- 部署：appgdep_6acb0e6bf0108191897fa04e08bdbc78，succeeded，环境修订6，公开访问策略保留。
- 公网健康检查2026-10-11T04:21:45.812Z：版本0.3.9、Web/D1均ok、模型configured；请求11/20，剩余9次。本轮未调用模型。

## 后续真实网页验收（2026-10-11）

- 任务 `task_6cece52d-5ac7-447f-b09f-7ba01b1dec6b` 审批前JSON和最终报告/JSON均为格式1.3，最终状态COMPLETED。最终双格式校验和为 `964c01a1c5b23935`；规划证据与审批前对象深度相等。
- modelDecision记录Qwen选择group_compare、item_sales和region，entityField为空；程序compile补入order_id，policy将ready改为clarify并添加口径澄清，置信度0.75由程序设置。这首次真实确认了模型选择与程序补齐分别保存。
- 全部质量风险记录为kept；最终口径为原数据全状态按region求和item_sales，源文件版本匹配。独立复算及DuckDB均得到华南288.5、华东189.8、华北0；835字符SQL完整，四项独立引擎对账通过。
- 此前任务ca230810由旧前端导出格式1.2；JSON为审批前、报告为完成后，校验和差异是不同阶段快照。完成后JSON(2)与报告一致，但无modelDecision。强制刷新后新任务6cece52d才验收新增字段，不回填旧任务。
- 本记录属于项目所有者操作的单题真实链路验收。首次目标用户研究和留出表达评估仍未完成，下一步材料见 `evaluation/user_test_round1/`。

## 解释边界

- modelDecision是通过工具参数校验的模型结构化输入，工具模式将省略的字段补为空字符串；不包含原始HTTP或思考过程。
- 程序从该决策生成完整计划文案及置信度，随后人工确认业务口径；任何正确结果不能反推出模型原始决定。
- 新版真实Qwen导出已经通过一条完整链路；此前v1.2任务不能从最终字段反填缺失决策。该任务只验收记录链路，不测一般自然语言准确率。
