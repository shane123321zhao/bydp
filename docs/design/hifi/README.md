# hifi/ — 画板源码归档（不可本地打开）

> **状态：P1 高保真 v1 已冻结（2026-09-23，PO 通过）。** 任何改动须 PO 裁定并升版本号；开发以 `field-mapping.md` + `api-contract.yaml` 为约束。

设计稿**只在 Claude Design 画板看**：https://claude.ai/artifact/1RXfg7eFx4TdNHcRRX5b63
本目录的 `.dc.html` 是画板组件源码，依赖画板运行时，双击打开会乱码——仅用于入库追踪与后期转开发代码。

| 文件 | 是什么 | 状态 |
|---|---|---|
| `canvas.json` | 画板索引（板位、便签） | — |
| `HomeV9.dc.html` | **01 首页 · 当前版 F2.2**（含日夜令牌） | 通过（暂定） |
| `HomeV9Night.dc.html` | 首页夜间挂载板（theme=dark） | 同上 |
| `Check.dc.html` | **02 查询结果 · 五态单组件**（state 枚举，dense 默认） | 冻结 v1 |
| `CheckNight / CheckCert / CheckFake / CheckWatch / CheckUnknown.dc.html` | 查询结果各态挂载板 | 同上 |
| `Brand.dc.html` | **03 品牌页 · 单组件**（tab 枚举：概览/投诉/出款/标识/优惠） | 冻结 v1 |
| `BrandNight / BrandComplaints / BrandWithdrawal / BrandDomains / BrandOffers.dc.html` | 品牌页各 Tab 挂载板 | 同上 |
| `List.dc.html` | **04 名单页 · 单组件**（lib 枚举：认证/非认证/持牌/黑名单 + 地区筛选） | 冻结 v1 |
| `ListNight / ListWatch / ListLicensed / ListBlacklist.dc.html` | 名单页各库挂载板 | 同上 |
| `Complaint.dc.html` | **05 投诉流程 · 单组件**（step 枚举：提交表单 / 我的进度 / 公开案件页） | 冻结 v1 |
| `ComplaintProgress / ComplaintCase / ComplaintNight.dc.html` | 投诉流程各态挂载板 | 同上 |
| `Me.dc.html` · `MeNight.dc.html` | **06 我的**（登录态）+ 夜间 | 冻结 v1 |
| `Offers.dc.html` · `OffersNight.dc.html` | **07 优惠 Tab**（真实价值榜，筛选可点）+ 夜间 | 冻结 v1 |
| `HomeV2.dc.html` | 参考 B · 暗夜雷达 | 挂起保留 |
| `Main.dc.html` · `CheckResult.dc.html` | 参考 A · 第一版首页 / 查询结果 | 挂起保留 |

规则：新页面 = 一个组件文件 + 若干挂载板；被否决的探索版本不入库。
