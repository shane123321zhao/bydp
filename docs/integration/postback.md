# BYDP 运营商回传（Postback）对接说明 v1 · 2026-09-28

> 面向已与 BYDP 签约的运营商技术团队。本接口为服务器对服务器调用，不面向终端用户。依据：architecture §7 v1.6（OperatorIntegration / Conversion）、A-007。

## 1. 端点
`POST https://<api-host>/v1/postback/{brandId}` —— `brandId` 由 BYDP 在对接时提供。

## 2. 鉴权（HMAC-SHA256）
| 项 | 值 |
|---|---|
| 密钥 | 对接时由 BYDP 线下发放（≥ 32 字节随机串），只在你方服务器与 BYDP 服务器环境变量中保存，任何一方不入库明文 |
| 请求头 `X-BYDP-Timestamp` | Unix 秒（整数字符串） |
| 请求头 `X-BYDP-Signature` | `hex( HMAC-SHA256( secret, "{timestamp}.{rawBody}" ) )`，小写十六进制 |
| 时间窗 | 默认 ±300 秒（可按品牌配置 30–300），超窗拒绝 |
| 正文 | `Content-Type: application/json`，**无 BOM 的 UTF-8**，签名以发送的原始字节为准（不要在签名后再格式化） |
| 大小 | ≤ 64 KB |

伪代码：`sig = hmac_sha256(secret, timestamp + "." + body_bytes).hexdigest()`

## 3. 正文字段
```json
{
  "externalEventId": "op-evt-20260928-000123",   // 必填，运营商侧唯一事件 id（≤128）；重复发送同一 id 会被判 duplicate，不重复处理
  "event": "first_deposit",                       // 必填：register | first_deposit | deposit | reversal
  "operatorAccountId": "JL88xxxx271",             // 必填，运营商侧账号 id（≤128）。BYDP 只存其 HMAC 哈希用于匹配，不存明文
  "clickId": "clk_...",                           // 可选。用户经 BYDP 跟踪链接注册时你方落地页收到的参数，请原样回传；带 clickId 才能完成「回传确认」
  "amountUsdt": 200.00,                           // deposit / first_deposit 强烈建议携带（非强制）；USDT 计价，两位小数
  "occurredAt": "2026-09-28T10:20:30+08:00",      // 可选，ISO 8601 带时区；仅作记录，归因以 BYDP 接收时间为准
  "reversesExternalEventId": null                 // 仅 event=reversal 必填：被冲正的原事件 id；同一原事件只能冲正一次
}
```

## 4. 返回
| 状态 | 含义 | 你方处理 |
|---|---|---|
| 200 `{ok:true, conversion:"recorded"}` | 已记录 | 完成 |
| 200 `{ok:true, conversion:"duplicate"}` | 该 externalEventId 已处理过 | 完成（幂等） |
| 200 `{ok:true, conversion:"already_reversed"}` | 原事件已被冲正 | 完成 |
| 400 | 正文格式错误；或 clickId 不存在 / 不属于本品牌；或冲正对象本身是冲正事件 | 修正后重发（同 externalEventId 即可） |
| 401 | 鉴权失败（签名 / 时间戳 / 对接配置任一不通过，**对外统一 401**） | 检查密钥、时间同步、原始字节；**若确认签名无误仍持续 401，请按 1 分钟 / 5 分钟 / 30 分钟重试最多 3 次，并联系 BYDP**（可能是我方配置事故） |
| 409 | 冲正的原事件尚未收到 | 先补发原事件，再重发冲正 |
| 413 | 正文超 64 KB | 拆分 |
| 429 | 60 秒内失败超过 60 次（仅失败计数，成功请求不消耗） | 指数退避后重试 |
| 500 / 503 | BYDP 侧异常 | 可重试（建议 1m / 5m / 30m / 2h，最多 5 次；同 externalEventId） |

## 5. 事件语义与结算
- `register`：不产生佣金，仅用于归因与绑定确认。
- `first_deposit`：CPA 结算触发点（同一账号只结一次；结算金额按条款，不按 amountUsdt）；**强烈建议**带 amountUsdt，供对账与未来 RevShare 使用。
- `deposit`：记录用；P1 不按充值额分成（RevShare 待净收入回传格式确认后启用）。
- `reversal`：对原事件的更正，只追加不修改；对应佣金作废。
- 归因：末次点击、30 天窗口，以 BYDP 接收时间为基准；无 clickId 时按账号哈希匹配已绑定用户，但**不升级**绑定核验等级。
- 黑名单品牌与关联方（ADR-0003）在任何情况下不结算。

## 6. 落地页要求
用户经 BYDP 跟踪链接到达你方注册页时，URL 中会带 `clickId` 查询参数（模板由 BYDP 配置、目标主机须为你方官方域名）。请把它写入注册会话，并在 register / first_deposit 回传中原样带回。

## 7. 联调步骤
1. BYDP 在测试环境为你方品牌建立对接（发放测试密钥、brandId）。
2. 你方用测试密钥发送 register → first_deposit → reversal 三条，核对返回。
3. 双方核对 BYDP 后台的转化记录与你方事件 id 一致。
4. 切换生产密钥；生产环境 BYDP 源站只接受 Cloudflare 回源，请从固定出口 IP 调用并告知 BYDP 以便白名单（可选）。

## 8. 变更
本文件版本随 `packages/tracking` 算法版本走；字段增删将提前 30 天通知并保持向后兼容。
