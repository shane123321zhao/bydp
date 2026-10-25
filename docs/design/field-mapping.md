# BYDP P1 字段映射表 — 页面展示字段 → 架构 §7 实体.字段

> 2026-09-23 · 设计纪律：每个信任信号必须能映射到本表；映射不到的不画。
> 来源实体见 `docs/architecture-v1.md` §7；mock 数据见 `fixtures/*.json`；接口见 `api-contract.yaml`。
> 标记：**聚合** = 后端计算字段（需在 API 返回）；**派生** = 前端由已有字段计算。

## 01 首页 `HomeV9.dc.html` — `GET /home`
| 区块 | 展示字段 | 实体.字段 | 备注 |
|---|---|---|---|
| 顶栏 | 在库平台数 | 聚合 `stats.brandsIndexed` | Brand count |
| 仿冒预警条 | 今日新增仿冒数 · 最新仿冒标识 · 被冒充品牌 | 聚合 `alerts.fakeToday` · Identifier(ownership=fake).value · EntityLink(impersonates)→Brand.name | |
| 主表盘 | 评分 · 置信度 · 可用因子数 | ScoreSnapshot.score · .confidence · .factorsAvailable/.factorsTotal | 指针角 = −90 + 180·score/100（派生） |
| 主表盘 | 品牌名 · 状态 · 牌照机构 | Brand.name · Brand.status · License.regulator | 推荐位来源：scoring 排序 Top1（ADR-0006） |
| 主表盘 | 出款中位 · 保证金 | ScoreSnapshot.factors[withdrawal].detail · Brand.certifiedDepositUsdt | |
| 主表盘副题 | 算法版本 · 重算时间 | ScoreSnapshot.algorithmVersion · .computedAt | |
| 小表盘 ×4 | 品牌名 · 评分 / 黑名单 | Brand.name · ScoreSnapshot.score · Brand.status | 黑名单：score=null，指针 0 红 |
| KPI | 收录 · 黑名单(+今日) · 受理 · 解决率 | 聚合 `stats.brandsIndexed` · `stats.blacklisted` + `stats.blacklistedToday` · `stats.complaintsHandled` · `stats.resolveRate` | sparkline = 30 日序列 `stats.series.*` |
| 四库入口 | 四库计数 | 聚合 `libs.certified/watch/licensed/blacklist` | licensed = License.valid=true 跨库 |
| 保证金背书 | 保证金总额 | 聚合 Σ Brand.certifiedDepositUsdt（status=certified） | 链上验证链接 → 合约地址（P3） |
| 近期被查询较多（原「本周热查」） | 标识 · 7 日查询数（distinct 网段） | Candidate.value · Candidate.queryCount7d | 排序 weightedPriority；展示门槛：有风险信号或 ≥ 5 网段（v1.13） |
| 我的（登录） | 绑定数 · 赔付资格 · 进行中投诉数 · 昵称 | count(UserBrandBinding) · any(compensationEligible) · count(Complaint status∉{resolved,rejected,exposed}) · User.displayName | 未登录显示登录入口 |
| Log | 日期 · 主体 · 说明 · 状态标签 | 聚合 `feed[]`：source ∈ {Identifier(fake), Exposure, StatusHistory, Complaint(resolved)} | 每条带 kind + entityId |
| 认证横条 | 品牌 · 优惠标题 · 流水 · 真实价值 · 保证金 · 码 | Offer.title · .terms.rolloverMultiple · .trueValue.netExpectedValueUsdt · Brand.certifiedDepositUsdt · PromoCode.code | |
| 内容双格 | 实验室标题 · 爆仓概率 · 防骗标题 | Content(type=lab).title · SimResult.bustProbability · Content(type=guide).title | |
| 合规行 | 声明 · 链接 | 静态；`/regions` `/methodology` `/disclosure` `/safe-play` `/official` | ADR-0007 |

## 02 查询结果 `Check.dc.html` — `GET /check?q=`
| 区块 | 展示字段 | 实体.字段 | 备注 |
|---|---|---|---|
| 顶栏 | 查询串 | 请求 q（Identifier 规范化后） | |
| 01 判定 | 匹配说明 · 核验时间 | 聚合 `match.note`（规范化类型 + 归属）· ScoreSnapshot.computedAt / Candidate 时间 | |
| 01 判定 | 状态标签 · 判定语 · 状态色 | Brand.status × Identifier.ownership → verdict ∈ {blacklist, certified, fake, watch, unknown} | 判定语五句：别存。/ 可以存。/ 这是假的。/ 谨慎。/ 先别存。 |
| 01 判定 | 评分 · 副题 | ScoreSnapshot.score · .confidence · .factorsAvailable | 黑名单/仿冒/未收录 显示 — |
| 01 判定 | 品牌 · 元信息 | Brand.name · Brand.name.en · Operator.legalName · License.licenseNo · Brand.markets | |
| 三事实 | 按态 | 黑名单：Exposure.complaintIds.length · Exposure.totalClaimedUsdt · Identifier.firstSeen→lastChecked（派生月数）；认证：factors[withdrawal/arbitration].detail · 拒付率；仿冒：EntityLink.confidence · Identifier.firstSeen（派生天数）· count(Identifier official)；观察：拒付率 · 出款中位 · 解决率；未收录：Candidate.queryCount7d · riskSignals.length · WHOIS 天数 | |
| 02 黑名单/观察 | 关联行 | EntityLink.fromId/toId → Identifier.value 或 Brand.name · .linkType · .confidence · .confirmedBy · Identifier.online | 条宽 = confidence |
| 02 认证 | 因子行 | ScoreSnapshot.factors[].label · .detail · .score · .weight · .available | 条宽 = score |
| 02 仿冒 | 官方标识行 | Identifier(brandId, ownership=official).value · .type · .firstSeen · .online | |
| 02 未收录 | 风险信号行 | Candidate.riskSignals[]（+ 严重度，Agent 输出） | 标注"待人工确认" |
| 03 时间线 | 日期 · 动作 · 说明 · 关键点 | StatusHistory · Complaint.createdAt/acceptedAt/exposedAt · EntityLink.confirmedAt · Candidate.firstQueried | 红点 = 判定类事件 |
| 04 行动 | 主按钮 · 次按钮 · 建议 | 按 verdict 静态文案；建议文案 Content(type=advice, key=verdict) | |
| 05 同类可信 | Top1 认证品牌 | scoring 排序（排除当前品牌） | 认证态不显示 |
| 未收录 · 你是不是要找（D-019） | 候选品牌行：Logo · 名称 · 状态徽标 · 主域名 | `suggestions[]`（BrandCard，≤ 5，Meilisearch / 降级 Postgres；只按品牌名与官方标识匹配） | 仅未收录态；副题（#29 定稿）：「以下为名称相近的已收录品牌，不代表推荐；若你查的域名与其官网不一致，可能是仿冒站」 |

## 03 品牌页 `Brand.dc.html` — `GET /brands/{slug}` + 子资源
| 区块 | 展示字段 | 实体.字段 | 备注 |
|---|---|---|---|
| 顶栏 | 品牌名 · 状态章 | Brand.name · Brand.status | |
| 01 表盘 | 评分 · 置信 · 牌照号 · 年限 · 市场 · 英文名 · 主体 | ScoreSnapshot · License.licenseNo · Operator.foundedYear（派生年限）· Brand.markets · Brand.name.en · Operator.legalName | |
| 01 三事实 | 出款中位 · 解决率 · 保证金 | factors[withdrawal].detail · factors[arbitration].detail · Brand.certifiedDepositUsdt | |
| Tab 栏 | 计数 | count(Complaint publicSummary) · count(WithdrawalReport) · count(Identifier) · count(Offer 在效) | |
| 概览 Tab | 五因子 | ScoreSnapshot.factors[] | `GET /brands/{slug}/score` |
| 投诉 Tab | 案件行 · KPI | Complaint(publicSummary=true).id/title/category/status/createdAt/resolvedAt · 聚合解决率 / 中位响应 | `GET /brands/{slug}/complaints` |
| 投诉 Tab · 相关案件搜索（D-019） | 输入框 · 结果行同上 | 请求 `q` → Complaint(publicSummary=true).title / publicDescription（**不含 description 原文**） | `GET /brands/{slug}/complaints?q=` |
| 出款 Tab | 分布 · 抽检 · KPI | WithdrawalReport 按到账时长分桶（聚合）· WithdrawalReport(kind=official) · 中位 / 拒付率 / 样本数 | `GET /brands/{slug}/withdrawals` |
| 标识 Tab | 标识行 · KPI | Identifier.value/.type/.ownership/.firstSeen/.online · EntityLink(impersonates).confidence | `GET /brands/{slug}/identifiers` |
| 优惠 Tab | 优惠行 · KPI | Offer.title/.terms/.trueValue/.exclusive/.sponsored · PromoCode.claimedCount | `GET /brands/{slug}/offers` |
| Offer 横条 | 首选优惠 · 码 | Offer(exclusive=true) · PromoCode.code | |
| 行动 | 投诉 · 提交出款凭证 | → `POST /complaints` · `POST /me/withdrawal-reports` + `POST /me/withdrawal-reports/{id}/evidence`（截图 ≥ 1 张才可采纳）· 页面 `/me/withdrawal-report?b=<slug>` | D-024 |
| 评分因子 · 玩家评价行 | 「写评价」 | → `POST /me/reviews`（Review.rating / .text；文字不公开）· 页面 `/me/review?b=<slug>` | D-024 · 裁定 ③④ |

## 04 名单页 `List.dc.html` — `GET /lists/{lib}?region=&sort=`
| 区块 | 展示字段 | 实体.字段 | 备注 |
|---|---|---|---|
| 四库切换 | 计数 | 聚合 `libs.*` | |
| 筛选 | 地区 · 排序 | Brand.markets · sort ∈ {score_desc, listed_at_desc} | 黑名单默认 listed_at |
| 搜索（D-019，高保真顶栏搜索按钮 → 实现为表头下方常驻搜索框） | 输入框 · 清除 | 请求 `q` → Brand.name 三语 / slug / Identifier.value（归一到简体） | 无匹配显示「本名单中没有与…匹配」 |
| KPI | 本筛选数 · 平均分 / 曝光中 / 监管机构数 / 含换皮 / 今日 · 保证金 | 聚合 | 按 lib 不同 |
| 行 | 序号 · 表盘 · 名称 · 元信息 · 副行 · 评分 · 标签 | rank（派生）· ScoreSnapshot.score · Brand.name · License.regulator + 年限 · factors 摘要 / Exposure 摘要 · Brand.status / Brand.hasActiveExposure / License.valid | 黑名单行：Exposure.complaintIds.length · totalClaimedUsdt · StatusHistory.at |
| 说明条 | 库规则 | 静态文案（按 lib） | |

## 05 投诉流程 `Complaint.dc.html`
| 态 | 展示字段 | 实体.字段 | 接口 |
|---|---|---|---|
| 公用 | 步骤条当前节点 · 进度 | Complaint.status → {submitted, screening, accepted, awaiting_reply, arbitrating, resolved/rejected/exposed} | |
| 表单 | 对象品牌 · 评分 · 绑定状态 | Brand · ScoreSnapshot.score · UserBrandBinding.verificationLevel（null=未绑定） | `GET /brands/{slug}` `GET /me/bindings` |
| 表单 | 类型 · 金额 · 日期 · 经过 | Complaint.category ∈ {refused, delay, frozen, bonus, closed} · .amountUsdt · .eventDate · .description | `POST /complaints` |
| 表单 | 证据 · 哈希 | Evidence.type · .sha256 · .redacted | `POST /complaints/{id}/evidence`（服务端计算 sha256） |
| 进度 | 状态章 · 倒计时 · 金额 · 通知次数 | Complaint.status · .replyDeadline · .amountUsdt · operatorNotifiedAt / secondNoticeAt（派生次数） | `GET /me/complaints/{id}` |
| 进度 | 记录 | StatusHistory(complaintId) | |
| 案件页 | 结论章 · 标题 · 三事实 · 品牌行 | Complaint.status · .title · .amountUsdt · 通知次数 · acceptedAt→exposedAt（派生天数）· Brand + ScoreSnapshot | `GET /cases/{id}`（仅 publicSummary） |
| 案件页 | 双方陈述 | Complaint.description（脱敏）· OperatorReply.summary / 无 → 占位 | |
| 案件页 | 判定过程 | StatusHistory · EntityLink.confirmedAt | |

## 06 我的 `Me.dc.html` — `GET /me`
| 区块 | 展示字段 | 实体.字段 |
|---|---|---|
| 身份 | 昵称 · 登录方式 · 加入时间 · 地区 · 语言 · 等级 · 积分 · 下一级差值 | User.displayName · Identity.provider/handle · User.joinedAt · .region · .locale · .level · .points · 积分规则（可配，`GET /config/points`） |
| 四格 | 绑定 / 投诉（进行中/总）/ 码 / 订阅 计数 | count(UserBrandBinding) · count(Complaint by user) · count(PromoCode claimed by user) · count(Subscription) |
| 我的绑定 | 品牌 · 评分 · 账号（掩码）· 来源 · 核验等级 · 赔付资格 | UserBrandBinding.brandId→Brand · ScoreSnapshot · .operatorAccountId（服务端掩码）· .source · .promoCodeId · .verificationLevel · .compensationEligible |
| 动态 | 合并流 | Complaint · PromoCode claim · Subscription · UserBrandBinding.boundAt · Notification |
| 官方验证 | 官方域名 · TG · Bot · 当前站点是否官方 | 静态配置 `GET /config/official-channels` |
| 设置 | 语言 · 通知 · 自我排除 · 隐私删除 | User.locale · Subscription.channel · `POST /me/self-exclusion` · `POST /me/data-requests` |

## 07 优惠 Tab `Offers.dc.html` — `GET /offers?filter=&sort=ev_desc`
| 区块 | 展示字段 | 实体.字段 |
|---|---|---|
| 筛选 | 全部 / 仅认证 / 正期望 / 品类 | Brand.status=certified · Offer.trueValue.netExpectedValueUsdt>0 · Offer.terms.eligibleGames |
| KPI | 正期望数 · 补贴型数 · 已领码 | 聚合 · Σ PromoCode.claimedCount |
| 行 | 品牌 · 标题 · 条款 · 状态 · 真实价值 · 结论 · 风险标签 | Brand.name · Offer.title · .terms（rolloverMultiple/eligibleGames/validDays/maxWithdrawalUsdt）· Brand.status + Offer.exclusive · .trueValue.netExpectedValueUsdt · .trueValue.verdictText · Brand.status≠certified → riskLabel |
| 领码 | 码 | PromoCode.code（登录后发放，记 Click） → `POST /offers/{id}/claim` |

## 缺口清单（设计阶段发现，需回写架构 §7 或 fixtures）
1. `Complaint.eventDate`（事件日期）与 `Complaint.title` 未在 §7 明列 → 建议补入。
2. `Candidate.riskSignals[]` 需结构化为 `{signal, severity, source}` 而非字符串。
3. `SimResult.bustProbability` 首页引用，§7 仅有 SimResult 实体名 → 补字段。
4. 积分规则 `PointsRule`（可配）与 `User.level/points` → §7 用户域补实体。
5. 官方渠道配置 `OfficialChannel` → §7 后台与治理域补实体（或作为 Config）。
6. `Content(type=advice, key=verdict)` 判定建议文案 → 内容域 Content 增 type 枚举。

7. `Brand.logoUrl`（品牌 Logo，R2 对象键）→ 架构 v1.2 §7 运营商域缺失；P1 原型用首字字标占位。官方域名取 `Identifier(type=domain, ownership=official, primary=true)`，已有。

> **v1.3 数据来源修正（2026-09-26）**：文中 `Exposure.complaintIds.length` 一律读作 `count(ExposureComplaint where exposureId)`；`Exposure.linkedBrandIds` 由 `EntityLink` 推出；API 响应形态不变，由 packages/core 组装。gap #7 中「`Identifier.primary` 已有」为误记，现已作为新字段写入 §7 v1.3。品牌 Logo 读 `Brand.logoUrl`，缺素材为 null，前端回退首字字标。

> **v1.6（2026-09-28）**：「已领码」KPI 与 `PromoCode.claimedCount` 脱钩，改为 `count(distinct click where promoCodeId, 24h 内同用户去重)`；claimedCount 字段保留为可选缓存，不作真源。领码返回 `clickId`，`code` / `trackingUrl` 可空。
