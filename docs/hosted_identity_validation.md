# 线上第二身份隔离验证

## 验证目标

使用两个真实且不同的登录身份，双向验证：每个身份可以创建并读取自己的 TaskRun，但读取另一个身份的 TaskRun 必须返回 HTTP 404。

同一账号的普通窗口与无痕窗口、伪造 `oai-authenticated-user-id` 请求头、本地协议测试，都不能替代这项线上验证。

## 准备

1. 保持站点为 `custom` 访问模式；
2. 将第二个真实账号加入站点允许列表，并由该账号接受邀请；
3. 用两个独立 Edge 数据目录分别登录所有者和第二身份；
4. 两个窗口都打开 `https://metricground.chirpyseed1.chatgpt.site`，确认能进入应用而不是登录页。

可在 PowerShell 中启动两个隔离窗口：

```powershell
Start-Process msedge.exe -ArgumentList '--remote-debugging-port=9224','--user-data-dir=C:\Temp\metricground-owner','https://metricground.chirpyseed1.chatgpt.site'
Start-Process msedge.exe -ArgumentList '--remote-debugging-port=9225','--user-data-dir=C:\Temp\metricground-second','https://metricground.chirpyseed1.chatgpt.site'
```

不要复制或提交浏览器 Cookie。两个调试端口只应在本机验证期间开放，完成后关闭两个测试浏览器。

## 执行

在 `frontend/` 目录运行：

```powershell
npm run test:hosted:isolation
```

脚本通过两个浏览器页面发起同源、带真实登录会话的请求，不读取或输出 Cookie。通过条件为：

| 检查 | 期望 |
|---|---:|
| 两个 `/api/session` | `authenticated=true`、`required=true` |
| 所有者读取自己的 TaskRun | 200 |
| 第二身份读取所有者 TaskRun | 404 |
| 第二身份读取自己的 TaskRun | 200 |
| 所有者读取第二身份 TaskRun | 404 |

验证输出中的两个探针 TaskRun ID 和执行时间应保存到 `evaluation/`，再查询 D1 的 `task_run_owners`，确认两个 TaskRun 对应不同的 `owner_hash`。只有浏览器结果和 D1 绑定同时吻合，才可把能力更新为“线上第二身份隔离实测通过”。
