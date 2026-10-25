# packages/tracking

点击 / 转化 / 佣金归因（§7 v1.5 G1–G4，A-007 双签：db + tracking）。

- **边界**：只依赖 `@bydp/db`，以 bydp_app 连接写 click / conversion / commission / commission_event；由 `@bydp/core/commerce/tracking` 编排调用，apps 不直接使用。scoring 不可达本包（dependency-cruiser + eslint + isolation 测试）。
- **绑定**：本包不读写 user_brand_binding。回传的绑定匹配与「回传确认」升级在 core 的 bindings 模块完成，本包只接收 core 算好的 `bindingUserId`。
- **只追加**：click / conversion / commission / commission_event 由迁移 0005 的触发器 + 权限双重保证；更正走冲正事件与 `commission_event(void)`。

| 模块 | 内容 |
|---|---|
| `claim.ts` | 领码：前置校验、24h 幂等、`{clickId}` 替换（URL 编码）+ WHATWG `new URL()` 复核主机属当前官方标识（A-007 F1 第 2 层） |
| `signature.ts` | postback 验签：HMAC-SHA256(`timestamp + "." + rawBody`)、常量时间比较、时间窗；密钥只经 `postbackSecretRef` 从环境变量取 |
| `conversion.ts` | 回传体校验、幂等写入、冲正、末次点击 30 天归因 |
| `commission.ts` | 条款选择（同合作方优先）、CPA / RevShare 计算、黑名单 / 关联方硬拦截、冲正 → void |
