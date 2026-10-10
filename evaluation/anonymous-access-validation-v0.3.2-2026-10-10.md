# v0.3.2 匿名新人测试上线验证

验证日期：2026-10-10（Asia/Shanghai）。初始匿名版探针完成时间：10:36；最终修复版复测完成时间：11:24。

## 部署事实

- 公开地址：<https://metricground.chirpyseed1.chatgpt.site>
- Site：`appgprj_6ac7bf4b8d84819195312b901d476b57`，访问模式 `public`。
- Sites 当前版本：6，保存版本 ID：`appgprj_6ac7bf4b8d84819195312b901d476b57~appgver_b610af1fa3188191a655cb0ddb89ec8c`。
- 当前部署：`appgdep_6ac9afc83d248191a69e12f8c0ff8204`，返回 `succeeded`。
- 当前托管源码：`51685b7f5bde11c90d4cd0ee04c6266df3661010`，经源仓库回读验证。
- 初始功能提交：`a9a1b33109c5ac55bed915cb7217fcf24f9f7cd9`；最终压力恢复修复提交：`a42304af5d08c7b86a1800ec4ba1b181e7abc655`。
- 同日初始匿名版为 Sites 版本 5，源码 `b6f456228a0250b94ed6df0c1467456a0847be82`。下列匿名接口检查在版本 6 全部再次通过。
- 运行时环境修订 2：`METRICGROUND_REQUIRE_AUTH=false`，`METRICGROUND_ANONYMOUS_SESSIONS=true`。
- `/api/health` 版本 `0.3.2`，Web/D1 为 `ok`；模型为 `unavailable`、非必需。清晰计数任务使用确定性策略路由；本轮不能证明云端大模型已接入。

## 未登录线上接口实测

执行 `frontend/scripts/verify-hosted-anonymous-session.ps1`，使用两个没有账号 Cookie 的独立 WebRequestSession。没有使用 Sites 服务访问令牌或登录身份头。

| 检查 | 实际结果 |
| --- | --- |
| 首页、会话与健康接口 | 200 |
| 会话身份 | authenticated=false、required=false、anonymous=true |
| Cookie 属性 | HttpOnly、SameSite=Lax、Secure；两个会话不同 |
| 会话刷新 | 身份保持稳定，不重新签发 Cookie |
| 缺少匿名会话的核心 API | 401、ANONYMOUS_SESSION_REQUIRED |
| 合法匿名计数规划 | 200、metric、entityField=order_id |
| A / B 创建自己的 TaskRun | 201 / 201 |
| A / B 读取自己的 TaskRun | 200 / 200 |
| A / B 读取对方 TaskRun | 404 / 404 |
| B 尝试覆盖 A 的 TaskRun | 409，current=null |

最终复测探针 ID：`task_hosted_anonymous_a_c31b27368c334e8bbaf18bdea9dee8a4`、`task_hosted_anonymous_b_c31b27368c334e8bbaf18bdea9dee8a4`。它们只保存合成测试元数据，没有上传真实数据行。

## 本地与远程回归

- 本地静态门禁、类型检查、生产构建及匿名 Cookie 边界测试通过。
- 显式匿名模式下的双向隔离、幂等写入、修订冲突、跨站写入拒绝、载荷上限和限流通过。
- 功能提交的远程 [CI 38017052569](https://github.com/LMM1234556/metricground/actions/runs/38017052569) 静态与浏览器门禁均通过，但该轮浏览器服务仍为本地默认访问配置。
- 后续显式开启匿名模式的 [CI 38017310908](https://github.com/LMM1234556/metricground/actions/runs/38017310908) 在清洗测试失败：固定 60ms 等待后找不到确认按钮。此前的跨场景、Agent、画像与质量步骤通过。
- [CI 38017572655](https://github.com/LMM1234556/metricground/actions/runs/38017572655) 的匿名浏览器流程、桌面/移动计算、完整发布浏览器回归、刷新恢复与 API 持久化均通过；后续新增匿名 HTTP 探针等待首个 `/api/session` 响应超时，所以整体结论为失败，不能写成全套 CI 通过。
- 后续清洗测试再次暴露旧页面/文件解析尚未完成时操作的隐患。测试现先清空工作区、等待本次上传完成，再读取实际控件；HTTP 探针限制请求最长 15 秒，并记录非敏感请求状态。
- 压力后首个请求无响应曾在 fetch 和 curl 两种客户端复现；单纯统一地址或取消未读请求体不足以消除问题。最终在认证、跨站、限流、载荷拒绝路径中，有上限地读取并释放请求体（64KiB 读取预算、500ms 时间期限），并加入不重试的“限流后会话首次响应 200”硬断言。该回归已通过；不把临时诊断请求的容错当作通过条件。
- 最终 [CI 38020033588](https://github.com/LMM1234556/metricground/actions/runs/38020033588) 对应 `a42304af5d08c7b86a1800ec4ba1b181e7abc655`，静态门禁和显式匿名模式完整浏览器门禁均为 success。压力后首次会话响应 200，独立匿名 Cookie 隔离通过，D1 备份/恢复演练通过。生产页面源码与这份通过的功能代码一致；后续交付文档更新不修改运行逻辑。

## 验证限制

本机自动安全检查拒绝启动浏览器调试实例，所以本次本机浏览器点击回归未执行。远程浏览器回归单独列明，不冒充线上真实设备走查。Node fetch 直连托管站点收到 403，而 PowerShell 的未登录请求通过；因此线上结论基于上述明确客户端和已通过的探针。

Windows 发布辅助工具调用 Bash 打包失败（当前没有 Bash）。已通过官方源仓库辅助工具推送并回读源码；继续使用官方 `prepare-site-build.cjs` 验证构建输出，按官方脚本相同清单用系统 tar 打包，检查 `dist/.openai/hosting.json` 后上传。部署包不含依赖目录、原始文件或凭据。

Cookie 有效期 7 天，同一浏览器配置共享身份。清除、过期或恢复强制登录后不能自动迁移匿名记录。正式目标用户研究仍未完成，不能把这些探针当作新人测试人数或生产准确率证据。
