# apps/admin

运营后台（Next.js，basePath `/admin`）— 看板 / 仲裁台 / 数据请求 / 审核台 / 风控 / 角色。

- 只调用 api `/admin/v1/*`（契约 `docs/design/api-contract-admin.yaml`），不直连数据库；权限与重新验证由 api 判定。
- 与 web 同域部署（Caddy `/admin*` → admin:3200），读取 Auth.js 会话 cookie 并作为 `Authorization: Bearer` 转发。
- 环境变量：`ADMIN_API_URL`（api 内网地址，默认 `http://127.0.0.1:8787`）。
- 本地：`pnpm --filter @bydp/admin dev`（端口 3200，访问 http://localhost:3200/admin），需 api 同时运行。
- 网络层另加 Cloudflare Access（上线前置 #4）；测试站用 Caddy Cookie 门禁（W2#010 起取代 Basic Auth）。
