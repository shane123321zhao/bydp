/**
 * fixtures（docs/design/fixtures/*.json）→ seed 行。纯函数，不连库，便于测试。
 *
 * 原则：字段名与 fixtures 一致直接入库；**不补造数据**（CLAUDE.md 铁律）。
 * 仅做以下有据可查的形态转换（PO 裁定 2026-09-25 已认可；原 T1 category 映射随 fixtures 统一为契约枚举而删除）：
 *   T2 identifier.fakeNote → note（api-contract Identifier 只有 note）
 *   T3 entityLink.fromKind/toKind：由 id 前缀派生（br_ / idf_）
 *   T4 candidate.riskSignals：字符串 → { signal }（架构 v1.2 结构化；severity/source 缺失不补）
 *   T5 promoCode.code "—" → null（自动发放无码）
 *   T6 users[].identities[] → identity 行
 *   T7 无 id 的行由 seed 生成确定性代理键：scoreSnapshots → ss_seed_NNN；identities → idn_<userId>_<n>；statusHistory → bigserial
 *   T8 userBrandBindings.operatorAccountIdHash = HMAC(SEED_BINDING_HMAC_KEY, operatorAccountId)（测试密钥，仅 seed 使用）
 *   T9 A-011：operatorAccountId → operatorAccountIdEnc（AES-256-GCM，AAD = binding.id）+ operatorAccountIdMasked，明文不入库
 *      （密钥：seed 脚本传入 AUTH_PII_KEY，未设置时用 SEED_PII_KEY 测试密钥）
 * 违反约束的行（外键指向不存在的用户、证据哈希非 64 位十六进制）整行跳过并记入 skipped，不以占位替代。
 * 不阻断但需 PO 知晓的问题记入 warnings（丢弃的 `_` 注释字段、悬空引用、自相矛盾的快照、未入库的聚合块）。
 */

import { encryptOperatorAccountId, maskOperatorAccount } from '../binding-crypto';
import { hashOperatorAccountId } from '../binding-hash';

type Row = Record<string, unknown>;
export type Fixtures = { operators: Row; trust: Row; commerceUsers: Row };
export type Skip = { table: string; id: string; reason: string };
export type SeedPlan = { tables: Array<{ table: string; rows: Row[] }>; skipped: Skip[]; warnings: string[] };

/** 仅供 seed / 测试的 HMAC 密钥（非生产；生产密钥只来自环境变量 BINDING_HMAC_KEY） */
export const SEED_BINDING_HMAC_KEY = 'bydp-seed-only-test-key-not-for-production-0001';
/** 仅供 seed / 测试的账号加密密钥（32 字节；非生产，生产只来自环境变量 AUTH_PII_KEY） */
export const SEED_PII_KEY = Buffer.from('bydp-seed-only-pii-key-not-prod!', 'utf8');

/** T9：明文 → 密文 + 掩码，删除明文字段 */
export function sealBindingRow(r: Row, piiKey: Buffer): Row {
  const { operatorAccountId, ...rest } = r;
  const plain = String(operatorAccountId);
  return { ...rest, operatorAccountIdEnc: encryptOperatorAccountId(plain, piiKey, String(r.id)), operatorAccountIdMasked: maskOperatorAccount(plain) };
}
/** 已知的 fixtures 注释值（PO 裁定补齐的 mock 行），不作告警 */
const KNOWN_NOTES = new Set(['PO 裁定补齐', '协调官 D-003 补齐']);

const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const kindOf = (id: string): 'brand' | 'identifier' => {
  if (id.startsWith('br_')) return 'brand';
  if (id.startsWith('idf_')) return 'identifier';
  throw new Error(`entityLink 端点 id 前缀无法识别：${id}`);
};
const ts = (v: unknown) => (v == null ? v : new Date(String(v)));
const tsFields = (r: Row, keys: string[]): Row => {
  const out = { ...r };
  for (const k of keys) if (k in out) out[k] = ts(out[k]);
  return out;
};

export function buildSeed(fx: Fixtures, piiKey: Buffer = SEED_PII_KEY): SeedPlan {
  const skipped: Skip[] = [];
  const warnings: string[] = [];
  /** 去掉 `_` 前缀注释字段；非空的注释内容记入 warnings（不入库 ≠ 静默丢弃） */
  const stripMeta = (r: Row): Row => {
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('_') && v != null && v !== '' && !KNOWN_NOTES.has(String(v))) warnings.push(`${String(r.id ?? r.brandId ?? '?')}.${k}="${String(v)}" 为 fixtures 注释字段，未入库`);
    }
    return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
  };
  const o = fx.operators;
  const t = fx.trust;
  const c = fx.commerceUsers;

  // ---- 运营商域 ----
  const operators = arr(o.operators).map(stripMeta);
  const brands = arr(o.brands).map(stripMeta);
  const identifiers = arr(o.identifiers).map((r) => {
    const { fakeNote, ...rest } = stripMeta(r);
    if (fakeNote != null && rest.note != null) throw new Error(`identifier ${String(r.id)} 同时有 note 与 fakeNote`);
    return fakeNote != null ? { ...rest, note: fakeNote } : rest; // T2
  });
  const entityLinks = arr(o.entityLinks).map((r) =>
    tsFields({ ...stripMeta(r), fromKind: kindOf(String(r.fromId)), toKind: kindOf(String(r.toId)) }, ['confirmedAt']),
  ); // T3
  const licenses = arr(o.licenses).map(stripMeta);
  const brandAttributes = arr(o.brandAttributes).map(stripMeta);
  const candidates = arr(o.candidates).map((r) => ({
    ...stripMeta(r),
    riskSignals: arr(r.riskSignals as unknown).map((s) => (typeof s === 'string' ? { signal: s } : s)), // T4
  }));

  // ---- 用户域 ----
  const userRows = arr(c.users).map(stripMeta);
  const users = userRows.map(({ identities: _identities, ...u }) => u);
  const identities = userRows.flatMap((u) =>
    arr(u.identities).map((idn, i) => ({ id: `idn_${String(u.id)}_${i + 1}`, userId: u.id, ...idn })),
  ); // T6
  const userIds = new Set(users.map((u) => String(u.id)));

  const requireUser = (table: string, r: Row): boolean => {
    if (userIds.has(String(r.userId))) return true;
    skipped.push({ table, id: String(r.id), reason: `userId=${String(r.userId)} 不在 fixtures.users 中（外键）` });
    return false;
  };

  // ---- 商业域 ----
  const offers = arr(c.offers).map(stripMeta);
  const promoCodes = arr(c.promoCodes).map((r) => {
    const row = stripMeta(r);
    return row.code === '—' ? { ...row, code: null } : row; // T5
  });

  const bindings = arr(c.userBrandBindings)
    .map((r) => tsFields(stripMeta(r), ['boundAt', 'postbackAt']))
    .map((r): Row => ({ ...r, operatorAccountIdHash: hashOperatorAccountId(String(r.operatorAccountId), SEED_BINDING_HMAC_KEY) })) // T8
    .map((r) => sealBindingRow(r, piiKey)) // T9
    .filter((r) => requireUser('user_brand_binding', r));
  const bindingIds = new Set(bindings.map((b) => String(b.id)));

  const reviews = arr(c.reviews)
    .map((r) => tsFields(stripMeta(r), ['createdAt']))
    .filter((r) => requireUser('review', r));
  const subscriptions = arr(c.subscriptions)
    .map(stripMeta)
    .filter((r) => requireUser('subscription', r));
  const notifications = arr(c.notifications)
    .map((r) => tsFields(stripMeta(r), ['sentAt']))
    .filter((r) => requireUser('notification', r));

  // ---- 信任域 ----
  const complaints = arr(t.complaints)
    .map((r) =>
      tsFields(stripMeta(r), [
        'createdAt',
        'acceptedAt',
        'operatorNotifiedAt',
        'secondNoticeAt',
        'replyDeadline',
        'operatorRepliedAt',
        'resolvedAt',
        'exposedAt',
      ]),
    )
    .filter((r) => requireUser('complaint', r))
    .filter((r) => {
      if (r.bindingId == null || bindingIds.has(String(r.bindingId))) return true;
      skipped.push({ table: 'complaint', id: String(r.id), reason: `bindingId=${String(r.bindingId)} 已被跳过（外键）` });
      return false;
    });
  const complaintIds = new Set(complaints.map((x) => String(x.id)));

  const evidence = arr(t.evidence)
    .map((r) => tsFields(stripMeta(r), ['uploadedAt']))
    .filter((r) => {
      if (!/^[0-9a-f]{64}$/.test(String(r.sha256))) {
        skipped.push({ table: 'evidence', id: String(r.id), reason: `sha256="${String(r.sha256)}" 非 64 位十六进制（fixtures 为截断展示值）` });
        return false;
      }
      if (!complaintIds.has(String(r.complaintId))) {
        skipped.push({ table: 'evidence', id: String(r.id), reason: `complaintId=${String(r.complaintId)} 已被跳过（外键）` });
        return false;
      }
      return true;
    });

  const operatorReplies = arr(t.operatorReplies)
    .map((r) => tsFields(stripMeta(r), ['repliedAt']))
    .filter((r) => {
      if (complaintIds.has(String(r.complaintId))) return true;
      skipped.push({ table: 'operator_reply', id: String(r.id), reason: `complaintId=${String(r.complaintId)} 已被跳过（外键）` });
      return false;
    });

  const withdrawalReports = arr(t.withdrawalReports)
    .map((r) => tsFields(stripMeta(r), ['requestedAt', 'receivedAt']))
    .filter((r) => {
      const badBinding = r.bindingId != null && !bindingIds.has(String(r.bindingId));
      const badComplaint = r.complaintId != null && !complaintIds.has(String(r.complaintId));
      if (!badBinding && !badComplaint) return true;
      skipped.push({ table: 'withdrawal_report', id: String(r.id), reason: '关联 binding/complaint 已被跳过（外键）' });
      return false;
    });

  const scoreSnapshots: Row[] = arr(t.scoreSnapshots).map((r, i) => ({
    id: `ss_seed_${String(i + 1).padStart(3, '0')}`, // T7
    ...tsFields(stripMeta(r), ['computedAt']),
  }));
  const exposures = arr(t.exposures).map((r) => tsFields(stripMeta(r), ['publishedAt']));
  const exposureIds = new Set(exposures.map((e) => String(e.id)));
  const exposureComplaints = arr(t.exposureComplaints)
    .map(stripMeta)
    .filter((r) => {
      if (exposureIds.has(String(r.exposureId)) && complaintIds.has(String(r.complaintId))) return true;
      skipped.push({ table: 'exposure_complaint', id: `${String(r.exposureId)}/${String(r.complaintId)}`, reason: '关联的 exposure / complaint 未入库（外键）' });
      return false;
    });
  const statusHistory = arr(t.statusHistory).map((r) => tsFields(stripMeta(r), ['at'])); // T7：id 由 bigserial 生成

  // ---- 一致性告警 ----
  for (const s of scoreSnapshots) {
    const factors = arr(s.factors);
    const avail = factors.filter((f) => f.available === true).length;
    // PO 裁定 #5：factors 中可用条数 = factorsAvailable；数组保留全部因子（含不可用行）= factorsTotal
    if (factors.length !== s.factorsTotal || avail !== s.factorsAvailable) {
      warnings.push(
        `score_snapshot ${String(s.brandId)}: factors 数组 ${factors.length} 项（available ${avail}）与 factorsTotal=${String(s.factorsTotal)} / factorsAvailable=${String(s.factorsAvailable)} 不一致`,
      );
    }
    // §5 冷启动 + S5 严格口径（PO 2026-09-27）+ 黑名单不计分：score 为 null ⇔ 黑名单 或 履约类因子（出款 / 仲裁 / 评价）全部不足
    const status = brands.find((b) => b.id === s.brandId)?.status;
    const perf = factors.some((f) => f.available === true && ['withdrawal', 'arbitration', 'playerReviews'].includes(String(f.key)));
    const shouldBeNull = status === 'blacklist' || !perf;
    if ((s.score == null) !== shouldBeNull) {
      warnings.push(`score_snapshot ${String(s.brandId)}: score=${String(s.score)} 与口径不符（黑名单或履约类因子全部不足才为 null）`);
    }
  }
  for (const k of Object.keys(c).filter((k) => !['_schema', 'offers', 'promoCodes', 'users', 'userBrandBindings', 'reviews', 'subscriptions', 'notifications'].includes(k))) {
    warnings.push(`commerce-users.json.${k} 不是 §7 实体（首页聚合 mock），未入库`);
  }

  return {
    skipped,
    warnings,
    tables: [
      { table: 'operator', rows: operators },
      { table: 'brand', rows: brands },
      { table: 'identifier', rows: identifiers },
      { table: 'entity_link', rows: entityLinks },
      { table: 'license', rows: licenses },
      { table: 'brand_attribute', rows: brandAttributes },
      { table: 'candidate', rows: candidates },
      { table: 'app_user', rows: users },
      { table: 'identity', rows: identities },
      { table: 'offer', rows: offers },
      { table: 'promo_code', rows: promoCodes },
      { table: 'user_brand_binding', rows: bindings },
      { table: 'review', rows: reviews },
      { table: 'subscription', rows: subscriptions },
      { table: 'notification', rows: notifications },
      { table: 'complaint', rows: complaints },
      { table: 'evidence', rows: evidence },
      { table: 'operator_reply', rows: operatorReplies },
      { table: 'withdrawal_report', rows: withdrawalReports },
      { table: 'score_snapshot', rows: scoreSnapshots },
      { table: 'exposure', rows: exposures },
      { table: 'exposure_complaint', rows: exposureComplaints },
      { table: 'status_history', rows: statusHistory },
    ],
  };
}

/** fixtures 原始条数（验收口径：seed 后 count(*) 与之一致） */
export function fixtureCounts(fx: Fixtures): Record<string, number> {
  const o = fx.operators;
  const t = fx.trust;
  const c = fx.commerceUsers;
  const n = (v: unknown) => arr(v).length;
  return {
    operator: n(o.operators),
    brand: n(o.brands),
    identifier: n(o.identifiers),
    entity_link: n(o.entityLinks),
    license: n(o.licenses),
    brand_attribute: n(o.brandAttributes),
    candidate: n(o.candidates),
    app_user: n(c.users),
    identity: arr(c.users).reduce((s, u) => s + n(u.identities), 0),
    offer: n(c.offers),
    promo_code: n(c.promoCodes),
    user_brand_binding: n(c.userBrandBindings),
    review: n(c.reviews),
    subscription: n(c.subscriptions),
    notification: n(c.notifications),
    complaint: n(t.complaints),
    evidence: n(t.evidence),
    operator_reply: n(t.operatorReplies),
    withdrawal_report: n(t.withdrawalReports),
    score_snapshot: n(t.scoreSnapshots),
    exposure: n(t.exposures),
    exposure_complaint: n(t.exposureComplaints),
    status_history: n(t.statusHistory),
  };
}
