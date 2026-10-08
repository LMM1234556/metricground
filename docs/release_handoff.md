# MetricGround 本地交付说明

> 交付日期：2026-09-22
> 交付形态：本地可运行的面试演示 MVP，不含公网部署和生产环境承诺。

## 交付范围

- React/TypeScript 分析工作台；
- CSV/XLSX 数据画像、质量检查和受控清洗副本；
- 指标合同、计数/金额/平均/条件比例、分组、趋势和 Top N；
- 最多三表的受控关联、N:N 阻断和来源行级金额对账；
- `AnalysisSpec`、`TaskRun`、人工确认、失败状态和证据导出；
- 浏览器确定性主计算与 DuckDB-WASM 独立 SQL 复核；
- Olist 只读演示快照、合成测试数据和自动化验证脚本。

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

验收结果以 `evaluation/release-acceptance-2026-09-22.md` 为准。单个脚本通过不代表生产级准确率，浏览器回归也不替代真实目标用户测试。

## 面试演示入口

1. 按 `docs/demo_guide.md` 完成五分钟主流程；
2. 按 `docs/interview_walkthrough.md` 解释模型、程序和人的分工；
3. 使用 `docs/resume_project_copy.md` 中的简历表述；
4. 使用 `docs/capability_matrix.md` 回答已完成能力与边界；
5. 使用 `evaluation/novice_test_files/` 开展新人测试，不要向参与者提供主持人答案。

## 当前验证状态

- 新人引导浏览器自动化断言：24/24；
- 5 份合成新人测试文件：均能上传并生成画像；
- 项目所有者手工冒烟测试：已走通 3/5 份；
- 正式目标用户测试：尚未完成；
- GitHub 仓库和公网地址：尚未创建。

“项目所有者测试 3 份文件”不能写成“3 名新人完成测试”。对外可以陈述：已具备真人测试材料和记录方案，正在进入目标用户验证阶段。

## 未交付能力

- 数据库连接、账户权限、任务持久化和多人协作；
- 任意复杂 Excel、多层表头和超大文件保证；
- 通用任意聚合量比例；
- 非常规金额字段的人工对账指定入口；
- 公网部署、监控告警和生产 SLA；
- 真实企业数据外部审计和生产级模型准确率。

## 发布前仍需人工完成

1. 选择 GitHub 仓库名称与公开/私有属性；
2. 确认项目许可证和 Olist 数据展示范围；
3. 检查提交中不包含 `.env`、API Key、浏览器配置和本地运行日志；
4. 选择部署平台并配置环境变量；
5. 邀请 5 名目标用户执行无指导测试，并把记录写入观察表。
