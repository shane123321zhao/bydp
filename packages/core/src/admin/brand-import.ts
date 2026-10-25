/**
 * D-027 品牌资料导入（HANDOVER §9 #39：后台没有新建运营商 / 品牌的功能，首批品牌经 Excel 模板导入）。
 * - 列定义 BRAND_IMPORT_SHEETS 是模板生成与解析的唯一来源（apps/worker/src/cli/brand-template.ts · import-brands.ts）。
 * - 先校验（文件内：必填 / 格式 / 重复 / 引用 / 关联方 / 黑名单理由与证据），再在单事务内写入；--dry-run = 同一写入路径执行后回滚，数据库约束也会被检出。
 * - 幂等：运营商按主体名称、品牌按 slug、标识按（品牌, 类型, 值）、牌照按（品牌, 机构, 编号）、属性按（品牌, 维度）更新；重复导入同一文件不新增行。
 * - 状态（自裁，保守）：初始状态只在**新建**品牌时生效，只能是观察 / 黑名单（认证须走认证流程）；已存在品牌的状态一律不改（权限规则见 admin/brands.ts），
 *   与表中不一致时给出提示，请在后台「品牌状态」操作。
 * - 黑名单：理由会公开显示在品牌页时间线（status_history.reason），按 checkReason 同一口径校验；证据链接只进 audit_log（内部），不公开。
 * - 牌照：「有效」须同时填核验日期与核验链接（valid 直接决定是否进入公开的持牌名单），否则按未核验导入（valid = false）。
 * - 属性：来源记 human、未核验；空单元格不改动已有值。导入不删除表中未出现的标识 / 牌照 / 属性（只增改）。
 * - 优惠（D-029）：trueValue 由 core commerce/true-value 按 architecture §8.1 计算，不接受手填；按（品牌, 标题）幂等；黑名单品牌不得有优惠；
 *   「条款原文」写入 offer.termsText（A-020，≤ 5000 字），只存不出（对外接口不返回）。Logo 首批不收（W2#012）。
 */
import { randomUUID } from 'node:crypto';
import { detect, normalizeDomain } from '@bydp/entity-graph';
import { schema, sql, type Db } from '@bydp/db';
import { checkReason } from './brands';
import { computeTrueValue, OFFER_TYPES, TrueValueError, type TrueValueInput } from '../commerce/true-value';
import { writeAudit, type Actor } from './rbac';

type Exec = Pick<Db, 'execute'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export type Column = { key: string; header: string; required?: boolean; note: string; example: string };
export type SheetDef = { key: 'operators' | 'brands' | 'identifiers' | 'licenses' | 'attributes' | 'offers'; name: string; intro: string; columns: Column[] };

export const IDENTIFIER_KIND: Record<string, { type: 'domain' | 'mirror' | 'app' | 'tg' | 'wallet'; primary?: boolean }> = {
  官方主域: { type: 'domain', primary: true },
  其他域名: { type: 'domain' },
  镜像域名: { type: 'mirror' },
  App: { type: 'app' },
  TG: { type: 'tg' },
  收款地址: { type: 'wallet' },
};
const OWNERSHIP: Record<string, 'official' | 'fake' | 'pending'> = { 官方: 'official', 仿冒: 'fake', 待查: 'pending' };
const STATUS: Record<string, 'watch' | 'blacklist'> = { 观察: 'watch', 黑名单: 'blacklist' };
export const ATTRIBUTE_DIMENSIONS: Record<string, string> = { payment: '支付方式', gameProvider: '游戏商', language: '语言', withdrawalLimit: '限额', support: '客服渠道' };

export const BRAND_IMPORT_SHEETS: SheetDef[] = [
  {
    key: 'operators',
    name: '运营商',
    intro: '每行一家运营商（公司主体）。主体名称是唯一键：再次导入同名主体会更新其余各列。',
    columns: [
      { key: 'legalName', header: '主体名称', required: true, note: '公司注册全称（唯一键）', example: '示例互动娱乐有限公司' },
      { key: 'jurisdiction', header: '注册地', note: '国家 / 地区两位代码，如 PH、CW、MT', example: 'PH' },
      { key: 'foundedYear', header: '成立年份', note: '四位年份', example: '2018' },
      { key: 'relatedParty', header: '是否关联方', required: true, note: '是 / 否。关联方旗下品牌永不认证、永不结佣', example: '否' },
    ],
  },
  {
    key: 'brands',
    name: '品牌',
    intro: '每行一个品牌。slug 是唯一键（网址里的名字）；再次导入同一 slug 会更新名称、运营商、目标市场，不改状态。',
    columns: [
      { key: 'slug', header: 'slug', required: true, note: '小写字母、数字、连字符，3–40 位；建后不要改', example: 'shili-jinxing' },
      { key: 'zhHans', header: '中文名', required: true, note: '简体中文名', example: '示例金星娱乐' },
      { key: 'zhHant', header: '繁体名', note: '可空', example: '示例金星娛樂' },
      { key: 'en', header: '英文名', note: '可空', example: 'Sample Venus Casino' },
      { key: 'operator', header: '所属运营商', required: true, note: '填「运营商」表或系统里已有的主体名称', example: '示例互动娱乐有限公司' },
      { key: 'markets', header: '目标市场', note: '国家 / 地区两位代码，用逗号或顿号分隔', example: 'MY、SG' },
      { key: 'status', header: '初始状态', required: true, note: '观察 / 黑名单（认证须走认证流程，不能导入）；只在新建时生效', example: '观察' },
      { key: 'reason', header: '黑名单理由', note: '黑名单必填；会公开显示在品牌页，请用中性描述，勿含人名 / 电话 / 账号', example: '' },
      { key: 'evidence', header: '黑名单证据链接', note: '黑名单必填；多个用换行分隔；只内部留档，不公开', example: '' },
    ],
  },
  {
    key: 'identifiers',
    name: '标识',
    intro: '每行一个网址 / App / TG / 收款地址。同一品牌只能有一个「官方主域」（官网按钮指向它）。',
    columns: [
      { key: 'brand', header: '品牌 slug', required: true, note: '填「品牌」表或系统里已有的 slug', example: 'shili-jinxing' },
      { key: 'kind', header: '类型', required: true, note: '官方主域 / 其他域名 / 镜像域名 / App / TG / 收款地址', example: '官方主域' },
      { key: 'value', header: '值', required: true, note: '域名不带 https://；TG 填 @账号；App 填包名；收款地址填完整地址', example: 'shili-jinxing.invalid' },
      { key: 'ownership', header: '归属', required: true, note: '官方 / 仿冒 / 待查；官方主域必须是「官方」', example: '官方' },
      { key: 'chain', header: '链', note: '收款地址填 TRC20 / ERC20，其他留空', example: '' },
      { key: 'note', header: '备注', note: '可空，内部可见', example: '' },
    ],
  },
  {
    key: 'licenses',
    name: '牌照',
    intro: '每行一张牌照。「有效」须同时填核验日期与核验链接，否则按「未核验」导入（不进入持牌名单）。',
    columns: [
      { key: 'brand', header: '品牌 slug', required: true, note: '同上', example: 'shili-jinxing' },
      { key: 'regulator', header: '发证机构', required: true, note: '如 PAGCOR、Curacao GCB、MGA', example: 'PAGCOR' },
      { key: 'licenseNo', header: '牌照编号', required: true, note: '按监管名录原样填写', example: 'OGL-2018-0000' },
      { key: 'verifiedAgainst', header: '核验链接', note: '监管公开名录中该牌照的页面', example: 'https://example.invalid/registry' },
      { key: 'verifiedAt', header: '核验日期', note: 'YYYY-MM-DD', example: '2026-10-01' },
      { key: 'result', header: '核验结果', required: true, note: '有效 / 未核验', example: '未核验' },
    ],
  },
  {
    key: 'attributes',
    name: '属性',
    intro: '每行一个品牌；每格多个值用逗号或顿号分隔；留空的格不改动已有值。',
    columns: [
      { key: 'brand', header: '品牌 slug', required: true, note: '同上', example: 'shili-jinxing' },
      { key: 'payment', header: '支付方式', note: '如 USDT-TRC20、DuitNow', example: 'USDT-TRC20、DuitNow' },
      { key: 'gameProvider', header: '游戏商', note: '如 Evolution、PG Soft', example: 'Evolution、PG Soft' },
      { key: 'language', header: '语言', note: '如 简体中文、English', example: '简体中文、English' },
      { key: 'withdrawalLimit', header: '限额', note: '如 单笔 50,000 USDT', example: '单笔 50,000 USDT' },
      { key: 'support', header: '客服渠道', note: '如 在线客服、Telegram', example: '在线客服' },
    ],
  },
  {
    key: 'offers',
    name: '优惠',
    intro: '每行一条优惠。「真实价值」由系统按公开口径自动计算，不用填；同一品牌下标题是唯一键，再次导入会更新该条。黑名单品牌不能有优惠。',
    columns: [
      { key: 'brand', header: '品牌 slug', required: true, note: '同上', example: 'shili-jinxing' },
      { key: 'title', header: '标题', required: true, note: '同一品牌内不重复，3–60 字', example: '首存 100% 奖励，最高 500 USDT' },
      { key: 'kind', header: '类型', required: true, note: '首存匹配 / 再存匹配 / 免死金 / 周返水（其他类型暂不支持）', example: '首存匹配' },
      { key: 'matchPercent', header: '匹配比例%', note: '匹配类必填，整数，如 100', example: '100' },
      { key: 'rebatePercent', header: '返水比例%', note: '周返水必填，可带小数，如 0.8', example: '' },
      { key: 'maxBonus', header: '最高奖励 USDT', note: '匹配类与免死金必填', example: '500' },
      { key: 'minDeposit', header: '最低存款 USDT', note: '可空', example: '50' },
      { key: 'rolloverMultiple', header: '流水倍数', required: true, note: '无流水填 0', example: '15' },
      { key: 'rolloverBase', header: '流水基数', required: true, note: '存款+奖励 / 奖励 / 存款 / 无', example: '存款+奖励' },
      { key: 'contributionPercent', header: '流水贡献率%', note: '可空，缺省 100；真人 / 体育常见 10–50', example: '100' },
      { key: 'maxWithdrawal', header: '最高提款 USDT', note: '可空', example: '5000' },
      { key: 'validDays', header: '有效天数', required: true, note: '完成流水的期限（天）', example: '30' },
      { key: 'eligibleGames', header: '适用游戏', required: true, note: '老虎机 / 捕鱼 / 体育 / 真人百家乐 等，逗号或顿号分隔', example: '老虎机、捕鱼' },
      { key: 'restrictedGames', header: '不适用游戏', note: '可空', example: '真人百家乐、体育' },
      { key: 'validUntil', header: '有效期至', note: 'YYYY-MM-DD，可空', example: '2026-12-31' },
      { key: 'exclusive', header: '独家', note: '是 / 否，缺省否', example: '是' },
      { key: 'termsText', header: '条款原文', note: '可空，≤ 5000 字；仅内部留档，暂不对外展示', example: '' },
    ],
  },
];

const OFFER_KIND: Record<string, string> = Object.fromEntries(Object.entries(OFFER_TYPES).map(([k, v]) => [v, k]));
const ROLLOVER_BASE: Record<string, string> = { '存款+奖励': 'deposit_plus_bonus', 奖励: 'bonus', 存款: 'deposit', 无: 'none' };
const num = (s: string | undefined) => (s == null || s === '' ? null : Number(s.replace(/,/g, '')));

/** 优惠行 → 真实价值输入（不合法的数字记 NaN，由校验报错） */
function offerInput(v: Record<string, string>): TrueValueInput & { validDays: number | null; restrictedGames: string[] } {
  return {
    type: OFFER_KIND[v.kind ?? ''] ?? v.kind ?? '',
    matchPercent: num(v.matchPercent),
    maxBonusUsdt: num(v.maxBonus),
    minDepositUsdt: num(v.minDeposit),
    validDays: num(v.validDays),
    restrictedGames: split(v.restrictedGames),
    terms: {
      rolloverMultiple: num(v.rolloverMultiple) ?? 0,
      rolloverBase: ROLLOVER_BASE[v.rolloverBase ?? ''] ?? v.rolloverBase ?? '',
      maxWithdrawalUsdt: num(v.maxWithdrawal),
      eligibleGames: split(v.eligibleGames),
      contributionPercent: num(v.contributionPercent),
      rebatePercent: num(v.rebatePercent),
    },
  };
}

/** 一行 = 表内行号（Excel 行号，便于 PO 定位）+ 按列 key 取值（已去首尾空白） */
export type ImportRow = { row: number; v: Record<string, string> };
export type ImportInput = Record<SheetDef['key'], ImportRow[]>;
export type ImportSummary = { created: Record<SheetDef['key'], number>; updated: Record<SheetDef['key'], number>; notes: string[]; brandIds: string[] };

export class BrandImportError extends Error {
  constructor(public readonly problems: string[]) {
    super(`共 ${problems.length} 处问题，未写入`);
    this.name = 'BrandImportError';
  }
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const CODE = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const split = (s: string | undefined) => (s ?? '').split(/[,，、;；\n]/).map((x) => x.trim()).filter(Boolean);
const sheetName = (k: SheetDef['key']) => BRAND_IMPORT_SHEETS.find((s) => s.key === k)!.name;
const isHttps = (s: string) => /^https:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(s);

/** 标识值规范化（与 /check 同一口径）；返回 null = 值与类型不符 */
export function normalizeIdentifier(type: 'domain' | 'mirror' | 'app' | 'tg' | 'wallet', raw: string): { value: string; chain?: string } | null {
  if (type === 'domain' || type === 'mirror') {
    const d = normalizeDomain(raw);
    return d && /^[a-z0-9.-]+$/.test(d) ? { value: d } : null;
  }
  const n = detect(raw);
  if (type === 'wallet') return n.type === 'wallet' ? { value: n.value, chain: n.chain } : null;
  if (type === 'tg') return n.type === 'tg' ? { value: n.value } : null;
  return n.type === 'app' ? { value: n.value } : null;
}

/** 文件内校验（不查库）。问题按「表 第 N 行：…」给出 */
export function validateImport(input: ImportInput): string[] {
  const p: string[] = [];
  const at = (k: SheetDef['key'], r: ImportRow, msg: string) => p.push(`「${sheetName(k)}」第 ${r.row} 行：${msg}`);
  for (const def of BRAND_IMPORT_SHEETS)
    for (const r of input[def.key]) for (const c of def.columns) if (c.required && !r.v[c.key]) at(def.key, r, `「${c.header}」必填`);

  const ops = new Map<string, ImportRow>();
  for (const r of input.operators) {
    const n = r.v.legalName;
    if (!n) continue;
    if (ops.has(n)) at('operators', r, `主体名称与第 ${ops.get(n)!.row} 行重复`);
    ops.set(n, r);
    if (r.v.jurisdiction && !CODE.test(r.v.jurisdiction)) at('operators', r, '注册地须为两位大写代码，如 PH');
    if (r.v.foundedYear && !(/^\d{4}$/.test(r.v.foundedYear) && +r.v.foundedYear >= 1990 && +r.v.foundedYear <= new Date().getUTCFullYear())) at('operators', r, '成立年份须为 1990 至今年的四位年份');
    if (r.v.relatedParty && !['是', '否'].includes(r.v.relatedParty)) at('operators', r, '是否关联方只能填「是」或「否」');
  }

  const slugs = new Map<string, ImportRow>();
  for (const r of input.brands) {
    const s = r.v.slug;
    if (s) {
      if (!SLUG.test(s)) at('brands', r, 'slug 只能用小写字母、数字、连字符，3–40 位，且不以连字符开头或结尾');
      if (slugs.has(s)) at('brands', r, `slug 与第 ${slugs.get(s)!.row} 行重复`);
      slugs.set(s, r);
    }
    if (r.v.status && !STATUS[r.v.status]) at('brands', r, r.v.status === '认证' ? '认证须走认证流程，不能通过导入设置' : '初始状态只能填「观察」或「黑名单」');
    for (const m of split(r.v.markets)) if (!CODE.test(m)) at('brands', r, `目标市场「${m}」须为两位大写代码，如 MY`);
    if (r.v.status === '黑名单') {
      if (!r.v.reason) at('brands', r, '黑名单须填写理由');
      else
        try {
          checkReason(r.v.reason);
        } catch (e) {
          at('brands', r, `黑名单理由：${(e as Error).message}`);
        }
      const ev = split(r.v.evidence);
      if (!ev.length) at('brands', r, '黑名单须至少填一个证据链接');
      for (const u of ev) if (!isHttps(u)) at('brands', r, `证据链接「${u.slice(0, 60)}」须以 https:// 开头`);
    } else if (r.v.reason || r.v.evidence) at('brands', r, '只有黑名单才填理由与证据链接');
    // 关联方与认证的冲突只可能出现在已存在的认证品牌上，入库阶段（applyImport）查
  }

  const primaries = new Map<string, ImportRow>();
  const seenIdf = new Map<string, ImportRow>();
  for (const r of input.identifiers) {
    const kind = IDENTIFIER_KIND[r.v.kind ?? ''];
    if (r.v.kind && !kind) at('identifiers', r, `类型只能填：${Object.keys(IDENTIFIER_KIND).join(' / ')}`);
    if (r.v.ownership && !OWNERSHIP[r.v.ownership]) at('identifiers', r, '归属只能填「官方」「仿冒」或「待查」');
    if (!kind || !r.v.value) continue;
    const n = normalizeIdentifier(kind.type, r.v.value);
    if (!n) {
      at('identifiers', r, `「${r.v.value.slice(0, 60)}」不是有效的${r.v.kind}`);
      continue;
    }
    if (kind.type === 'wallet' && r.v.chain && n.chain && r.v.chain.toUpperCase() !== n.chain) at('identifiers', r, `收款地址格式是 ${n.chain}，与「链」列不一致`);
    if (kind.type !== 'wallet' && r.v.chain) at('identifiers', r, '只有收款地址填「链」');
    const key = `${kind.type}|${n.value}`;
    if (seenIdf.has(key)) at('identifiers', r, `与第 ${seenIdf.get(key)!.row} 行是同一标识`);
    seenIdf.set(key, r);
    if (kind.primary) {
      if (r.v.ownership && r.v.ownership !== '官方') at('identifiers', r, '官方主域的归属必须是「官方」');
      const b = r.v.brand ?? '';
      if (primaries.has(b)) at('identifiers', r, `品牌 ${b} 已在第 ${primaries.get(b)!.row} 行填了官方主域，每个品牌只能有一个`);
      primaries.set(b, r);
    }
  }

  const lic = new Map<string, ImportRow>();
  for (const r of input.licenses) {
    if (r.v.result && !['有效', '未核验'].includes(r.v.result)) at('licenses', r, '核验结果只能填「有效」或「未核验」');
    if (r.v.verifiedAt && (!DATE.test(r.v.verifiedAt) || Number.isNaN(Date.parse(r.v.verifiedAt)) || r.v.verifiedAt > new Date().toISOString().slice(0, 10))) at('licenses', r, '核验日期须为 YYYY-MM-DD，且不晚于今天');
    if (r.v.verifiedAgainst && !isHttps(r.v.verifiedAgainst)) at('licenses', r, '核验链接须以 https:// 开头');
    if (r.v.result === '有效' && (!r.v.verifiedAt || !r.v.verifiedAgainst)) at('licenses', r, '「有效」须同时填核验日期与核验链接（否则请填「未核验」）');
    const key = `${r.v.brand}|${r.v.regulator}|${r.v.licenseNo}`;
    if (lic.has(key)) at('licenses', r, `与第 ${lic.get(key)!.row} 行是同一张牌照`);
    lic.set(key, r);
  }

  const attrs = new Map<string, ImportRow>();
  for (const r of input.attributes) {
    const b = r.v.brand ?? '';
    if (attrs.has(b)) at('attributes', r, `品牌 ${b} 已在第 ${attrs.get(b)!.row} 行填写，每个品牌一行`);
    attrs.set(b, r);
    if (!Object.keys(ATTRIBUTE_DIMENSIONS).some((d) => split(r.v[d]).length)) at('attributes', r, '至少填一项属性');
  }

  const offerKeys = new Map<string, ImportRow>();
  for (const r of input.offers) {
    const v = r.v;
    if (v.kind && !OFFER_KIND[v.kind]) at('offers', r, `类型只能填：${Object.values(OFFER_TYPES).join(' / ')}（其他类型暂不支持）`);
    if (v.rolloverBase && !ROLLOVER_BASE[v.rolloverBase]) at('offers', r, '流水基数只能填：存款+奖励 / 奖励 / 存款 / 无');
    if (v.title && (Array.from(v.title).length < 3 || Array.from(v.title).length > 60)) at('offers', r, '标题须 3–60 字');
    const key = `${v.brand}|${v.title}`;
    if (offerKeys.has(key)) at('offers', r, `与第 ${offerKeys.get(key)!.row} 行同品牌同标题`);
    offerKeys.set(key, r);
    for (const [k, label] of [['matchPercent', '匹配比例%'], ['rebatePercent', '返水比例%'], ['maxBonus', '最高奖励'], ['minDeposit', '最低存款'], ['rolloverMultiple', '流水倍数'], ['contributionPercent', '流水贡献率%'], ['maxWithdrawal', '最高提款'], ['validDays', '有效天数']] as const) {
      const n = num(v[k]);
      if (n != null && !(Number.isFinite(n) && n >= 0)) at('offers', r, `「${label}」须为不小于 0 的数字`);
    }
    if (v.matchPercent && !/^\d{1,4}$/.test(v.matchPercent)) at('offers', r, '匹配比例% 须为整数');
    if (v.validDays && !/^\d{1,4}$/.test(v.validDays)) at('offers', r, '有效天数须为整数');
    if (v.validUntil && (!DATE.test(v.validUntil) || Number.isNaN(Date.parse(v.validUntil)))) at('offers', r, '有效期至须为 YYYY-MM-DD');
    if (v.exclusive && !['是', '否'].includes(v.exclusive)) at('offers', r, '独家只能填「是」或「否」');
    if (v.termsText && Array.from(v.termsText).length > 5000) at('offers', r, '条款原文不超过 5000 字');
    if (v.kind && OFFER_KIND[v.kind] && v.rolloverBase && ROLLOVER_BASE[v.rolloverBase] && v.eligibleGames)
      try {
        computeTrueValue(offerInput(v));
      } catch (e) {
        if (!(e instanceof TrueValueError)) throw e;
        at('offers', r, `无法计算真实价值：${e.message}`);
      }
  }
  return p;
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

/**
 * 入库（须在事务内调用；调用方决定提交或回滚 = --dry-run）。先 validateImport，再查库校验引用与冲突，全部通过才写。
 * actor：执行身份（W2#012：CLI 固定为系统身份 system:brand-import，不冒用真人账号）；file.requestedBy = 谁要求导入（真实导入为 PO 的 userId，
 * 模拟导入为 dev:D-xxx），记入文件级 audit。每个品牌一条 audit（before / after），另记一条文件级 audit（文件哈希、requestedBy 与计数）。
 */
export async function applyImport(tx: Exec, input: ImportInput, actor: Actor, file: { name: string; sha256: string; requestedBy: string }): Promise<ImportSummary> {
  const problems = validateImport(input);
  if (problems.length) throw new BrandImportError(problems);
  const at = (k: SheetDef['key'], r: ImportRow, msg: string) => problems.push(`「${sheetName(k)}」第 ${r.row} 行：${msg}`);
  const zero = () => ({ operators: 0, brands: 0, identifiers: 0, licenses: 0, attributes: 0, offers: 0 });
  const sum: ImportSummary = { created: zero(), updated: zero(), notes: [], brandIds: [] };

  // ---- 查库校验 ----
  const opNames = [...new Set([...input.operators.map((r) => r.v.legalName!), ...input.brands.map((r) => r.v.operator!)])];
  const dbOps = await q<{ id: string; legalName: string; relatedParty: boolean }>(tx, sql`select "id", "legalName", "relatedParty" from ${schema.operators} where "legalName" in ${opNames.length ? sql`(${sql.join(opNames.map((n) => sql`${n}`), sql`, `)})` : sql`(null)`}`);
  const opByName = new Map(dbOps.map((o) => [o.legalName, o]));
  const sheetOps = new Set(input.operators.map((r) => r.v.legalName!));
  for (const r of input.brands) if (!sheetOps.has(r.v.operator!) && !opByName.has(r.v.operator!)) at('brands', r, `所属运营商「${r.v.operator}」既不在「运营商」表，也不在系统中`);

  const slugsInFile = input.brands.map((r) => r.v.slug!);
  const refSlugs = [...new Set([...slugsInFile, ...input.identifiers.map((r) => r.v.brand!), ...input.licenses.map((r) => r.v.brand!), ...input.attributes.map((r) => r.v.brand!), ...input.offers.map((r) => r.v.brand!)])];
  const dbBrands = await q<{ id: string; slug: string; status: string; operatorId: string }>(
    tx,
    sql`select "id", "slug", "status", "operatorId" from ${schema.brands} where "slug" in ${refSlugs.length ? sql`(${sql.join(refSlugs.map((s) => sql`${s}`), sql`, `)})` : sql`(null)`}`,
  );
  const brandBySlug = new Map(dbBrands.map((b) => [b.slug, b]));
  const fileSlugs = new Set(slugsInFile);
  for (const k of ['identifiers', 'licenses', 'attributes', 'offers'] as const)
    for (const r of input[k]) if (!fileSlugs.has(r.v.brand!) && !brandBySlug.has(r.v.brand!)) at(k, r, `品牌 slug「${r.v.brand}」既不在「品牌」表，也不在系统中`);

  // 关联方运营商下不得有认证品牌（库触发器兜底，这里给友好报错）
  for (const r of input.operators) {
    const o = opByName.get(r.v.legalName!);
    if (o && r.v.relatedParty === '是' && !o.relatedParty) {
      const [c] = await q<{ n: number }>(tx, sql`select count(*)::int as "n" from ${schema.brands} where "operatorId" = ${o.id} and "status" = 'certified'`);
      if (c!.n) at('operators', r, '该运营商旗下有认证品牌，不能改为关联方（关联方永不认证）');
    }
  }
  for (const r of input.brands) {
    const b = brandBySlug.get(r.v.slug!);
    const target = r.v.operator!;
    const sheetRelated = input.operators.find((o) => o.v.legalName === target)?.v.relatedParty;
    const related = sheetRelated ? sheetRelated === '是' : opByName.get(target)?.relatedParty;
    if (b?.status === 'certified' && related) at('brands', r, '认证品牌不能挂到关联方运营商下（关联方永不认证）');
  }

  // 标识：值已属于其他品牌 → 冲突；官方主域与库内已有主域不一致 → 冲突（更换主域请在后台处理）
  for (const r of input.identifiers) {
    const kind = IDENTIFIER_KIND[r.v.kind!]!;
    const n = normalizeIdentifier(kind.type, r.v.value!)!;
    const own = brandBySlug.get(r.v.brand!)?.id;
    const hits = await q<{ brandId: string | null; slug: string | null }>(
      tx,
      sql`select i."brandId", b."slug" from ${schema.identifiers} i left join ${schema.brands} b on b."id" = i."brandId" where i."type" = ${kind.type} and i."value" = ${n.value}`,
    );
    const other = hits.find((h) => h.slug !== r.v.brand);
    if (other) at('identifiers', r, `「${n.value}」已登记在品牌 ${other.slug ?? '（无品牌）'} 下`);
    if (kind.primary && own) {
      const [p] = await q<{ value: string }>(tx, sql`select "value" from ${schema.identifiers} where "brandId" = ${own} and "primary"`);
      if (p && p.value !== n.value) at('identifiers', r, `品牌已有官方主域 ${p.value}；更换主域请联系开发在后台处理，不经导入`);
    }
  }
  // 黑名单品牌不得有优惠（库触发器 offer_blacklisted_brand_inactive 兜底）：新建按表内初始状态，已存在按库内状态
  for (const r of input.offers) {
    const inFile = input.brands.find((b) => b.v.slug === r.v.brand);
    const status = brandBySlug.get(r.v.brand!)?.status ?? (inFile ? STATUS[inFile.v.status!] : undefined);
    if (status === 'blacklist') at('offers', r, `品牌 ${r.v.brand} 是黑名单，不能有优惠`);
  }
  if (problems.length) throw new BrandImportError(problems);

  // ---- 写入 ----
  await tx.execute(sql`select set_config('bydp.actor', ${actor.id}, true)`);
  const opId = new Map<string, string>();
  for (const r of input.operators) {
    const v = r.v;
    const row = { jurisdiction: v.jurisdiction || null, foundedYear: v.foundedYear ? Number(v.foundedYear) : null, relatedParty: v.relatedParty === '是' };
    const existing = opByName.get(v.legalName!);
    if (existing) {
      await tx.execute(
        sql`update ${schema.operators} set "jurisdiction" = coalesce(${row.jurisdiction}, "jurisdiction"), "foundedYear" = coalesce(${row.foundedYear}, "foundedYear"), "relatedParty" = ${row.relatedParty}, "updatedAt" = now() where "id" = ${existing.id}`,
      );
      opId.set(v.legalName!, existing.id);
      sum.updated.operators++;
    } else {
      const id = newId('op');
      await tx.execute(sql`insert into ${schema.operators} ("id", "legalName", "jurisdiction", "foundedYear", "relatedParty") values (${id}, ${v.legalName!}, ${row.jurisdiction}, ${row.foundedYear}, ${row.relatedParty})`);
      opId.set(v.legalName!, id);
      sum.created.operators++;
    }
  }
  for (const [name, o] of opByName) if (!opId.has(name)) opId.set(name, o.id);

  const brandId = new Map<string, string>();
  for (const r of input.brands) {
    const v = r.v;
    const name = { zhHans: v.zhHans!, ...(v.zhHant ? { zhHant: v.zhHant } : {}), ...(v.en ? { en: v.en } : {}) };
    const markets = split(v.markets);
    const operatorId = opId.get(v.operator!)!;
    const existing = brandBySlug.get(v.slug!);
    if (existing) {
      const [before] = await q<Record<string, unknown>>(tx, sql`select "name", "operatorId", "markets", "status" from ${schema.brands} where "id" = ${existing.id}`);
      await tx.execute(
        sql`update ${schema.brands} set "name" = ${JSON.stringify(name)}::jsonb, "operatorId" = ${operatorId}, "markets" = ${markets.length ? sql`array[${sql.join(markets.map((m) => sql`${m}`), sql`, `)}]::text[]` : sql`"markets"`}, "updatedAt" = now() where "id" = ${existing.id}`,
      );
      if (STATUS[v.status!] !== existing.status) sum.notes.push(`「品牌」第 ${r.row} 行：${v.slug} 现为「${({ certified: '认证', watch: '观察', blacklist: '黑名单' } as Record<string, string>)[existing.status]}」，导入不改状态；如需变更请在后台「品牌状态」操作`);
      await writeAudit(tx, actor, 'brand_import_update', { type: 'brand', id: existing.id }, before, { name, operatorId, markets: markets.length ? markets : undefined, file: file.name });
      brandId.set(v.slug!, existing.id);
      sum.updated.brands++;
    } else {
      const id = newId('br');
      const status = STATUS[v.status!]!;
      await tx.execute(
        sql`insert into ${schema.brands} ("id", "operatorId", "slug", "name", "status", "statusSince", "markets")
            values (${id}, ${operatorId}, ${v.slug!}, ${JSON.stringify(name)}::jsonb, ${status}, current_date, ${markets.length ? sql`array[${sql.join(markets.map((m) => sql`${m}`), sql`, `)}]::text[]` : sql`'{}'::text[]`})`,
      );
      // 新建不触发 R1（只在 UPDATE 时写）；首条状态记录由此显式写入（只追加表）
      await tx.execute(sql`insert into ${schema.statusHistory} ("brandId", "from", "to", "reason", "actor") values (${id}, null, ${status}, ${status === 'blacklist' ? checkReason(v.reason!) : '收录（批量导入）'}, ${actor.id})`);
      await writeAudit(tx, actor, 'brand_import_create', { type: 'brand', id }, null, {
        slug: v.slug,
        name,
        operatorId,
        markets,
        status,
        ...(status === 'blacklist' ? { reason: v.reason, evidence: split(v.evidence) } : {}),
        file: file.name,
      });
      brandId.set(v.slug!, id);
      sum.created.brands++;
    }
  }
  for (const [slug, b] of brandBySlug) if (!brandId.has(slug)) brandId.set(slug, b.id);

  for (const r of input.identifiers) {
    const kind = IDENTIFIER_KIND[r.v.kind!]!;
    const n = normalizeIdentifier(kind.type, r.v.value!)!;
    const bid = brandId.get(r.v.brand!)!;
    const ownership = OWNERSHIP[r.v.ownership!]!;
    const chain = kind.type === 'wallet' ? (n.chain ?? (r.v.chain?.toUpperCase() || null)) : null;
    const [ex] = await q<{ id: string }>(tx, sql`select "id" from ${schema.identifiers} where "brandId" = ${bid} and "type" = ${kind.type} and "value" = ${n.value}`);
    if (ex) {
      await tx.execute(sql`update ${schema.identifiers} set "ownership" = ${ownership}, "chain" = ${chain}, "note" = ${r.v.note || null}, "primary" = ${!!kind.primary}, "updatedAt" = now() where "id" = ${ex.id}`);
      sum.updated.identifiers++;
    } else {
      await tx.execute(
        sql`insert into ${schema.identifiers} ("id", "brandId", "type", "value", "ownership", "chain", "firstSeen", "note", "primary")
            values (${newId('idf')}, ${bid}, ${kind.type}, ${n.value}, ${ownership}, ${chain}, current_date, ${r.v.note || null}, ${!!kind.primary})`,
      );
      sum.created.identifiers++;
    }
  }

  for (const r of input.licenses) {
    const bid = brandId.get(r.v.brand!)!;
    const valid = r.v.result === '有效';
    const [ex] = await q<{ id: string }>(tx, sql`select "id" from ${schema.licenses} where "brandId" = ${bid} and "regulator" = ${r.v.regulator!} and "licenseNo" = ${r.v.licenseNo!}`);
    if (ex) {
      await tx.execute(sql`update ${schema.licenses} set "verifiedAgainst" = ${r.v.verifiedAgainst || null}, "verifiedAt" = ${r.v.verifiedAt || null}, "valid" = ${valid}, "updatedAt" = now() where "id" = ${ex.id}`);
      sum.updated.licenses++;
    } else {
      await tx.execute(
        sql`insert into ${schema.licenses} ("id", "brandId", "regulator", "licenseNo", "verifiedAgainst", "verifiedAt", "valid")
            values (${newId('lic')}, ${bid}, ${r.v.regulator!}, ${r.v.licenseNo!}, ${r.v.verifiedAgainst || null}, ${r.v.verifiedAt || null}, ${valid})`,
      );
      sum.created.licenses++;
    }
  }

  for (const r of input.attributes) {
    const bid = brandId.get(r.v.brand!)!;
    for (const dim of Object.keys(ATTRIBUTE_DIMENSIONS)) {
      const values = split(r.v[dim]);
      if (!values.length) continue;
      const arr = sql`array[${sql.join(values.map((x) => sql`${x}`), sql`, `)}]::text[]`;
      const [ex] = await q<{ n: number }>(tx, sql`select 1 as "n" from ${schema.brandAttributes} where "brandId" = ${bid} and "dimension" = ${dim}`);
      if (ex) {
        await tx.execute(sql`update ${schema.brandAttributes} set "values" = ${arr}, "source" = 'human', "verified" = false, "updatedAt" = now() where "brandId" = ${bid} and "dimension" = ${dim}`);
        sum.updated.attributes++;
      } else {
        await tx.execute(sql`insert into ${schema.brandAttributes} ("brandId", "dimension", "values", "source", "verified") values (${bid}, ${dim}, ${arr}, 'human', false)`);
        sum.created.attributes++;
      }
    }
  }

  for (const r of input.offers) {
    const bid = brandId.get(r.v.brand!)!;
    const o = offerInput(r.v);
    const tv = computeTrueValue(o);
    const terms = {
      rolloverMultiple: o.terms.rolloverMultiple,
      rolloverBase: o.terms.rolloverBase,
      maxWithdrawalUsdt: o.terms.maxWithdrawalUsdt ?? null,
      validDays: o.validDays ?? 0,
      restrictedGames: o.restrictedGames,
      eligibleGames: o.terms.eligibleGames,
      ...(o.terms.contributionPercent != null ? { contributionPercent: o.terms.contributionPercent } : {}),
      ...(o.terms.rebatePercent != null ? { rebatePercent: o.terms.rebatePercent } : {}),
    };
    const vals = { matchPercent: o.matchPercent ?? null, maxBonusUsdt: o.maxBonusUsdt ?? null, minDepositUsdt: o.minDepositUsdt ?? null, exclusive: r.v.exclusive === '是', validUntil: r.v.validUntil || null, termsText: r.v.termsText || null };
    const [ex] = await q<{ id: string }>(tx, sql`select "id" from ${schema.offers} where "brandId" = ${bid} and "title" = ${r.v.title!}`);
    if (ex) {
      await tx.execute(
        sql`update ${schema.offers} set "type" = ${o.type}, "matchPercent" = ${vals.matchPercent}, "maxBonusUsdt" = ${vals.maxBonusUsdt}, "minDepositUsdt" = ${vals.minDepositUsdt},
              "terms" = ${JSON.stringify(terms)}::jsonb, "trueValue" = ${JSON.stringify(tv)}::jsonb, "exclusive" = ${vals.exclusive}, "validUntil" = ${vals.validUntil}, "termsText" = ${vals.termsText}, "updatedAt" = now() where "id" = ${ex.id}`,
      );
      sum.updated.offers++;
    } else {
      await tx.execute(
        sql`insert into ${schema.offers} ("id", "brandId", "title", "type", "matchPercent", "maxBonusUsdt", "minDepositUsdt", "terms", "trueValue", "exclusive", "validUntil", "termsText")
            values (${newId('of')}, ${bid}, ${r.v.title!}, ${o.type}, ${vals.matchPercent}, ${vals.maxBonusUsdt}, ${vals.minDepositUsdt}, ${JSON.stringify(terms)}::jsonb, ${JSON.stringify(tv)}::jsonb, ${vals.exclusive}, ${vals.validUntil}, ${vals.termsText})`,
      );
      sum.created.offers++;
    }
  }

  sum.brandIds = [...new Set(input.brands.map((r) => brandId.get(r.v.slug!)!))];
  await writeAudit(tx, actor, 'brand_import_file', { type: 'brand_import', id: null }, null, { file: file.name, sha256: file.sha256, requestedBy: file.requestedBy, created: sum.created, updated: sum.updated });
  return sum;
}
