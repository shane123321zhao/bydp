# ADR-0006 评分与排序引擎隔离落地

- 日期：2026-09-23 · 状态：已采纳 · 裁定：PO
- 关联：架构 §5、§16；HANDOVER 决策 5；审计 A10、B4、C3、C4

## 背景
v1 只写"代码级隔离"口号，且只覆盖评分不覆盖排序；web 可直接 join tracking 表绕过包层隔离。

## 决策
1. 排序与推荐规则纳入 `packages/scoring`，与评分同等版本化、公开。
2. 三层隔离：① scoring 的 package.json 无 tracking 依赖；② eslint `no-restricted-imports` / dependency-cruiser 在 CI 与 PostToolUse Hook 中执行；③ scoring 使用独立只读 Postgres 角色 `bydp_scoring_ro`，授权为**白名单**：信任域全部表 + 运营商域非商业表（Operator / Brand / Identifier / EntityLink / License / BrandAttribute / Candidate）；其中 brand / withdrawal_report / complaint / review 为列级授权，排除保证金（certifiedDepositUsdt）与用户关联列；商业域、担保域、用户身份域一律不授权，新建表默认不可见。（2026-09-26 由「仅信任域表」改为白名单表述：§5 评分因子依赖 BrandAttribute / 关联图谱 / 标识监控，均在运营商域；隔离的本意是读不到佣金与付费数据，实测已达成。）
3. 业务逻辑集中于 `packages/core`，apps 不直连 db 做跨域 join。
4. `packages/db`：已应用的迁移文件禁改；新增迁移需独立审核会话签核；不整包冻结。

## 后果
Hook 拦截粒度按迁移文件而非整包；赞助位为独立组件、不参与排序。

## 白名单清单（2026-09-26，与 migrations/0002 实现核对一致，15 张）
- 信任域：status_history · score_snapshot · withdrawal_report（列级 12 列，含 fromBinding 与 **bindingId**——不透明 ID，scoring_ro 读不到 user_brand_binding / app_user，无法关联到人；迁移 0003 / 0004，A-002 / A-005）· complaint（列级）· operator_reply · exposure · exposure_complaint。**例外：evidence 不授权**——评分不读证据，且含原文对象键 storageKey；如未来因子需要证据计数，只允许列级且排除 storageKey。
- 运营商域非商业表：operator · brand（列级，排除 certifiedDepositUsdt 等保证金与用户关联列；含 logoUrl）· identifier · entity_link · license · brand_attribute · candidate。
- 用户域仅 review（列级）。商业域、担保域、用户身份域、user_role：禁止。
- 新增表默认不可见；每次迁移同步维护 GRANT，并由通用断言测试校验清单与实现一致。
