# MetricGround 公开访问权限核验

日期：2026-10-10

## 已核实事实

- Sites 访问模式已从 `custom` 改为 `public`，权限修订号为 3；
- Site 状态为 `active`，线上版本仍为 4；
- 匿名访问首页返回 HTTP 200；
- 匿名访问 `/api/health` 返回 HTTP 200，版本为 `0.3.1`，Web 与 D1 为 `ok`；
- 匿名访问 `/api/session` 返回 `authenticated=false`、`required=true`；
- 匿名调用 `/api/agent/plan` 返回 HTTP 401，提示该部署要求登录。

## 结论

当前是“公开入口、受保护核心”，不是匿名完整使用。任何人可以打开页面，但执行 Agent 核心流程仍需登录。不能仅通过关闭 `METRICGROUND_REQUIRE_AUTH` 宣称完成匿名开放，因为现有匿名回退所有者为固定的 `anonymous-local`，会让所有匿名浏览器共享 TaskRun 所有者边界。

如需公开且无需登录，应先实现随机匿名会话标识、按浏览器隔离 TaskRun、限流与清理策略，再关闭强制认证并重新执行越权回归。
