# v0.2.0 发布验证记录

验证日期：2026-10-08  
验证环境：Windows 11、Node.js 24.19.0、Microsoft Edge 154.0.4258.48、Cloudflare Wrangler 本地 D1。

## 结果

| 门禁 | 结果 | 关键证据 |
|---|---|---|
| 静态门禁 | 通过 | lint、TypeScript、生产构建、状态机、跨场景、关联、证据包与模型提供方测试均退出 0 |
| 浏览器门禁 | 通过 | 文件、质量、清洗、指标、执行、经营分析、多表关联、新人引导与恢复测试均退出 0 |
| 工作台固定任务 | 30/30 | 销售订单、客户营销、库存运营三种数据结构 |
| D1 健康检查 | HTTP 200 | `status=ok`、`checks.d1=ok`、`version=0.2.0` |
| 幂等重放 | 通过 | 首次写入 revision 1；相同幂等键重放仍为 revision 1 |
| 并发覆盖保护 | 通过 | 更新到 revision 2 后，旧 revision 写入返回 HTTP 409 |
| trace 隔离 | 通过 | 错误 traceId 读取返回 HTTP 404 |
| 刷新恢复 | 通过 | 上传文件画像和 TaskRun 刷新后恢复，浏览器运行时异常 0 |

## 验证命令

```powershell
cd frontend
npm run test:ci:static
npm start
npm run test:ci:browser
```

## 未验证或未完成

- GitHub 托管运行器上的远程 CI 尚未实际执行；
- 公网部署、真实身份认证、接口限流、集中监控告警和 D1 备份恢复演练尚未完成；
- 正式目标用户测试尚未完成。
