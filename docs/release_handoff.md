# MetricGround 本地交付说明

> 交付更新：2026-10-10（v0.3.3）
> 交付形态：本地可运行、可恢复且已发布的面试 MVP；当前公开环境临时免登录，TaskRun 按浏览器匿名会话隔离。匿名会话不具备账号找回和跨设备同步能力，也没有生产 SLA 承诺。

## 交付范围

- React/TypeScript 分析工作台；
- CSV/XLSX 数据画像、质量检查和受控清洗副本；
- 指标合同、计数/金额/平均/条件比例、分组、趋势和 Top N；
- 最多三表的受控关联、N:N 阻断和来源行级金额对账；
- `AnalysisSpec`、`TaskRun`、人工确认、失败状态和证据导出；
- 浏览器确定性主计算与 DuckDB-WASM 独立 SQL 复核；
- Olist 只读演示快照、合成测试数据和自动化验证脚本。
- D1 TaskRun 持久化、所有者绑定、接口限流、结构化日志、健康检查与备份恢复演练。

## 启动方式

```powershell
cd frontend
npm install
npm run dev
```

浏览器打开 `http://localhost:5173/`。Node.js 版本需不低于 22.13。Ollama 与 Qwen3:8b 是可选增强；未启动模型时，受支持的清晰任务使用规则安全降级。

## 交付验收

非浏览器验收：

```powershell
cd frontend
npm run test:release
```

浏览器验收需要开发服务和远程调试端口 `9224`：

```powershell
npm run test:release:browser
```

完整生产构建门禁使用 `npm run test:ci:static`；启动 `npm start` 和调试浏览器后运行 `npm run test:ci:browser`。后者还会执行移动冷缓存模拟 4G、API 防护与 D1 隔离恢复演练。

验收结果以 `evaluation/release-acceptance-2026-09-22.md` 为准。单个脚本通过不代表生产级准确率，浏览器回归也不替代真实目标用户测试。

## 面试演示入口

1. 按 `docs/demo_guide.md` 完成五分钟主流程；
2. 按 `docs/interview_walkthrough.md` 解释模型、程序和人的分工；
3. 使用 `docs/resume_project_copy.md` 中的简历表述；
4. 使用 `docs/capability_matrix.md` 回答已完成能力与边界；
5. 使用 `evaluation/novice_test_files/` 开展新人测试，不要向参与者提供主持人答案。

## 当前验证状态

- 当前公开版：v0.3.3 / Sites 版本 7，托管源码 `915d03cdbced89e3f2d02f6dac48059ecc6ac422`，环境修订 2。完整 CI、15 个实际 API 用例、10 个线上匿名路由探针和双会话隔离通过；模型未上线。当前证据以 `evaluation/intent-routing-validation-v0.3.3-2026-10-10.md` 为准，下文 v0.3.2/真实设备记录为历史验收。

- 新人引导浏览器自动化断言：24/24；
- 5 份合成新人测试文件：均能上传并生成画像；
- 项目所有者手工冒烟测试：已走通 3/5 份；
- 正式目标用户测试：尚未完成；
- 本地 Git 提交与标签：已建立；公开 GitHub 仓库与远程 CI：已建立并真实运行通过。
- 公开匿名测试：Sites 版本 6 成功，地址为 `https://metricground.chirpyseed1.chatgpt.site`；托管源码提交 `51685b7f5bde11c90d4cd0ee04c6266df3661010` 已回读核实；当前运行环境修订 2，强制登录关闭、匿名会话开启。未登录规划返回 200，双向自读 200、交叉读取 404、跨会话覆盖 409。匿名模式的完整远程 CI 已通过，包含限流后首次响应、工作区恢复和 D1 恢复检查。详见 `evaluation/anonymous-access-validation-v0.3.2-2026-10-10.md`。
- 线上验收：7/7 通过，覆盖登录、Web/D1 健康检查、上传、规划、批准、计算、DuckDB-WASM 复核、证据导出和同浏览器刷新恢复；TaskRun 修订 1—3、幂等写入和所有者绑定已在 D1 核实。
- 外部身份移动端验收：独立平板完成自己的主计算、DuckDB 复核、TaskRun 持久化和报告下载。
- 线上身份隔离：所有者和外部身份自读各自探针均为 200，双向交叉读取均为 404；D1 中两个探针绑定不同 `owner_hash`。
- 最小失败告警：已启用每小时 Sites 状态与 Worker 错误检查；正常静默，故障与恢复时通知。创建记录和边界见 `evaluation/hosted-alerting-2026-10-09.md`。

“项目所有者测试 3 份文件”不能写成“3 名新人完成测试”。对外可以陈述：已具备真人测试材料和记录方案，正在进入目标用户验证阶段。

## 未交付能力

- 外部数据库源连接、角色权限、团队空间和多人协作；
- 任意复杂 Excel、多层表头和超大文件保证；
- 通用任意聚合量比例；
- 非常规金额字段的人工对账指定入口；
- 匿名记录的账号迁移与找回、定时健康合成探测、完整 APM/值班升级链和生产 SLA；
- 真实企业数据外部审计和生产级模型准确率。

## 发布前仍需人工完成

1. 选择项目许可证并确认 Olist 数据展示范围；
2. 再次检查提交中不包含 `.env`、API Key、浏览器配置和本地运行日志；
3. 邀请 5 名目标用户执行无指导测试，并把记录写入观察表。
4. 若告警产生真实故障或恢复通知，保留平台通知及对应 Worker 日志；健康轮次按设计静默，不以缺少通知阻塞新人测试。
