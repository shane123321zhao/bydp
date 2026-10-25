/**
 * D-027 品牌资料导入：文件内校验（纯函数）+ 入库（已迁移 + seed 的库；事务内执行后回滚，以 bydp_app 身份）。
 * seed：br_jinlong（slug jinlong · 认证 · op_001「Golden Dragon Interactive Ltd.」· 官方主域 jinlong88.com）。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { applyImport, BrandImportError, validateImport, type ImportInput, type ImportRow } from '../src/admin/brand-import';
import { computeTrueValue } from '../src/commerce/true-value';

const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];
const ADMIN = { id: 'system:brand-import', role: 'admin' as const, ip: null };
const FILE = { name: 't.xlsx', sha256: 'x'.repeat(64), requestedBy: 'dev:D-027' };

const rows = (...vs: Record<string, string>[]): ImportRow[] => vs.map((v, i) => ({ row: i + 4, v }));
const input = (p: Partial<ImportInput>): ImportInput => ({ operators: [], brands: [], identifiers: [], licenses: [], attributes: [], offers: [], ...p });
const OP = { legalName: '测试运营商甲', jurisdiction: 'PH', foundedYear: '2018', relatedParty: '否' };
const BR = { slug: 'ceshi-jia', zhHans: '测试品牌甲', operator: '测试运营商甲', markets: 'MY、SG', status: '观察' };
const ok = () =>
  input({
    operators: rows(OP),
    brands: rows(BR, { ...BR, slug: 'ceshi-yi', zhHans: '测试品牌乙', status: '黑名单', reason: '多份出款凭证显示提款长期未处理', evidence: 'https://e.example.invalid/1' }),
    identifiers: rows(
      { brand: 'ceshi-jia', kind: '官方主域', value: 'https://www.Ceshi-Jia.invalid/', ownership: '官方' },
      { brand: 'ceshi-jia', kind: 'TG', value: 't.me/ceshi_jia_cs', ownership: '官方' },
      { brand: 'ceshi-yi', kind: '收款地址', value: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', ownership: '官方', chain: 'TRC20' },
    ),
    licenses: rows({ brand: 'ceshi-jia', regulator: 'PAGCOR', licenseNo: 'T-1', result: '有效', verifiedAt: '2026-10-01', verifiedAgainst: 'https://r.example.invalid/1' }),
    attributes: rows({ brand: 'ceshi-jia', payment: 'USDT-TRC20、DuitNow', support: '在线客服' }),
  });

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  let err: unknown;
  await conn!.db
    .transaction(async (tx) => {
      try {
        out = await fn(tx);
      } catch (e) {
        err = e;
      }
      tx.rollback();
    })
    .catch(() => {});
  if (err) throw err;
  return out as T;
}
const problemsOf = async (p: Promise<unknown>) => p.then(() => [] as string[], (e) => (e instanceof BrandImportError ? e.problems : [String(e)]));

describe('品牌导入：文件内校验', () => {
  it('合规文件无问题', () => expect(validateImport(ok())).toEqual([]));

  it('逐行中文报错：必填 / slug / 重复 / 认证不可导入 / 黑名单理由与证据 / 禁用词 / 市场代码 / 标识格式 / 主域唯一 / 牌照「有效」条件 / 链不一致', () => {
    const p = validateImport(
      input({
        operators: rows(OP, { ...OP, relatedParty: '可能' }),
        brands: rows(
          { ...BR, slug: 'Bad_Slug' },
          { ...BR, slug: 'ceshi-jia', zhHans: '' },
          { ...BR, slug: 'ceshi-jia' },
          { ...BR, slug: 'ceshi-c', status: '认证' },
          { ...BR, slug: 'ceshi-d', status: '黑名单' },
          { ...BR, slug: 'ceshi-e', status: '黑名单', reason: '确认是黑盘', evidence: 'http://x.invalid' },
          { ...BR, slug: 'ceshi-f', markets: 'Malaysia' },
        ),
        identifiers: rows(
          { brand: 'ceshi-jia', kind: '官方主域', value: 'not a domain', ownership: '官方' },
          { brand: 'ceshi-jia', kind: '官方主域', value: 'a.invalid', ownership: '待查' },
          { brand: 'ceshi-jia', kind: '官方主域', value: 'b.invalid', ownership: '官方' },
          { brand: 'ceshi-jia', kind: '收款地址', value: '0x52908400098527886E0F7030069857D2E4169EE7', ownership: '官方', chain: 'TRC20' },
          { brand: 'ceshi-jia', kind: '网站', value: 'c.invalid', ownership: '官方' },
        ),
        licenses: rows({ brand: 'ceshi-jia', regulator: 'PAGCOR', licenseNo: 'T-1', result: '有效' }),
        attributes: rows({ brand: 'ceshi-jia' }),
      }),
    );
    const has = (s: string) => expect(p.some((x) => x.includes(s)), `应包含：${s}\n实际：${p.join('\n')}`).toBe(true);
    has('「运营商」第 5 行：主体名称与第 4 行重复');
    has('是否关联方只能填「是」或「否」');
    has('「品牌」第 4 行：slug 只能用小写字母');
    has('「品牌」第 5 行：「中文名」必填');
    has('「品牌」第 6 行：slug 与第 5 行重复');
    has('认证须走认证流程，不能通过导入设置');
    has('「品牌」第 8 行：黑名单须填写理由');
    has('「品牌」第 8 行：黑名单须至少填一个证据链接');
    has('「品牌」第 9 行：黑名单理由：原因含不可对外使用的措辞');
    has('须以 https:// 开头');
    has('目标市场「Malaysia」须为两位大写代码');
    has('「标识」第 4 行：「not a domain」不是有效的官方主域');
    has('官方主域的归属必须是「官方」');
    has('每个品牌只能有一个');
    has('收款地址格式是 ERC20，与「链」列不一致');
    has('类型只能填');
    has('「有效」须同时填核验日期与核验链接');
    has('「属性」第 4 行：至少填一项属性');
  });
});

describe.skipIf(!url)('品牌导入：入库', () => {
  it('新建：运营商 / 品牌 / 标识（规范化）/ 牌照 / 属性；首条状态记录；黑名单证据只进 audit；再导入同一文件不新增', () =>
    inTx(async (tx) => {
      const a = await applyImport(tx, ok(), ADMIN, FILE);
      expect(a.created).toEqual({ operators: 1, brands: 2, identifiers: 3, licenses: 1, attributes: 2, offers: 0 });
      const [b] = (await tx.execute(sql`select "id", "status", "markets", "name" from "brand" where "slug" = 'ceshi-yi'`)) as unknown as { id: string; status: string; markets: string[] }[];
      expect(b!.status).toBe('blacklist');
      const sh = (await tx.execute(sql`select "from", "to", "reason", "actor" from "status_history" where "brandId" = ${b!.id}`)) as unknown as Record<string, string | null>[];
      expect(sh).toEqual([{ from: null, to: 'blacklist', reason: '多份出款凭证显示提款长期未处理', actor: 'system:brand-import' }]);
      const [fa] = (await tx.execute(sql`select "actorId", "after" from "audit_log" where "action" = 'brand_import_file' order by "id" desc limit 1`)) as unknown as { actorId: string; after: { requestedBy: string } }[];
      expect(fa).toMatchObject({ actorId: 'system:brand-import', after: { requestedBy: 'dev:D-027' } });
      const idf = (await tx.execute(sql`select i."value", i."primary", i."type" from "identifier" i join "brand" b on b."id" = i."brandId" where b."slug" = 'ceshi-jia' order by 1`)) as unknown as Record<string, unknown>[];
      expect(idf).toEqual([
        { value: '@ceshi_jia_cs', primary: false, type: 'tg' },
        { value: 'ceshi-jia.invalid', primary: true, type: 'domain' },
      ]);
      const [au] = (await tx.execute(sql`select "after" from "audit_log" where "action" = 'brand_import_create' and "targetId" = ${b!.id}`)) as unknown as { after: { evidence: string[] } }[];
      expect(au!.after.evidence).toEqual(['https://e.example.invalid/1']);
      const again = await applyImport(tx, ok(), ADMIN, FILE);
      expect(again.created).toEqual({ operators: 0, brands: 0, identifiers: 0, licenses: 0, attributes: 0, offers: 0 });
      expect(again.updated.brands).toBe(2);
    }));

  it('已存在品牌不改状态（给提示）；引用不存在的运营商 / slug、标识已属其他品牌、更换已有主域、认证品牌挂到关联方 → 报错且不写入', () =>
    inTx(async (tx) => {
      const s = await applyImport(tx, input({ brands: rows({ slug: 'jinlong', zhHans: '金龙娱乐城', operator: 'Golden Dragon Interactive Ltd.', status: '观察' }) }), ADMIN, FILE);
      expect(s.notes.join()).toContain('导入不改状态');
      const [st] = (await tx.execute(sql`select "status" from "brand" where "slug" = 'jinlong'`)) as unknown as { status: string }[];
      expect(st!.status).toBe('certified');

      const p = await problemsOf(
        applyImport(
          tx,
          input({
            operators: rows({ legalName: 'Golden Dragon Interactive Ltd.', relatedParty: '是' }),
            brands: rows({ ...BR, operator: '不存在的公司' }),
            identifiers: rows(
              { brand: 'ceshi-jia', kind: '其他域名', value: 'jinlong88.com', ownership: '官方' },
              { brand: 'jinlong', kind: '官方主域', value: 'jinlong-new.invalid', ownership: '官方' },
              { brand: 'no-such-brand', kind: 'TG', value: '@abcd_cs', ownership: '官方' },
            ),
          }),
          ADMIN,
          FILE,
        ),
      );
      const has = (x: string) => expect(p.some((y) => y.includes(x)), `应包含：${x}\n实际：${p.join('\n')}`).toBe(true);
      has('所属运营商「不存在的公司」既不在「运营商」表，也不在系统中');
      has('「jinlong88.com」已登记在品牌 jinlong 下');
      has('品牌已有官方主域 jinlong88.com');
      has('品牌 slug「no-such-brand」既不在「品牌」表，也不在系统中');
      has('旗下有认证品牌，不能改为关联方');
      const [n] = (await tx.execute(sql`select count(*)::int as "n" from "brand" where "slug" = 'ceshi-jia'`)) as unknown as { n: number }[];
      expect(n!.n).toBe(0);
    }));

  it('D-029 优惠：trueValue 由公式计算（不接受手填）；黑名单品牌拒绝；不支持类型报错；按（品牌, 标题）幂等', () =>
    inTx(async (tx) => {
      const OF = { brand: 'ceshi-jia', title: '测试首存 100%', kind: '首存匹配', matchPercent: '100', maxBonus: '500', minDeposit: '50', rolloverMultiple: '15', rolloverBase: '存款+奖励', validDays: '30', eligibleGames: '老虎机、捕鱼', exclusive: '是', termsText: '测试条款原文' };
      const base = ok();
      const r = await applyImport(tx, { ...base, offers: rows(OF) }, ADMIN, FILE);
      expect(r.created.offers).toBe(1);
      const [o] = (await tx.execute(sql`select o."trueValue", o."terms", o."exclusive" from "offer" o join "brand" b on b."id" = o."brandId" where b."slug" = 'ceshi-jia'`)) as unknown as { trueValue: unknown; terms: Record<string, unknown>; exclusive: boolean }[];
      expect(o!.trueValue).toEqual(computeTrueValue({ type: 'first_deposit_match', matchPercent: 100, maxBonusUsdt: 500, minDepositUsdt: 50, terms: { rolloverMultiple: 15, rolloverBase: 'deposit_plus_bonus', eligibleGames: ['老虎机', '捕鱼'] } }));
      expect(o!.trueValue).toMatchObject({ netExpectedValueUsdt: -40, methodVersion: 'tv-1' });
      expect(o!.exclusive).toBe(true);
      const [tt] = (await tx.execute(sql`select o."termsText" from "offer" o join "brand" b on b."id" = o."brandId" where b."slug" = 'ceshi-jia'`)) as unknown as { termsText: string }[];
      expect(tt!.termsText).toBe('测试条款原文'); // A-020
      const again = await applyImport(tx, { ...base, offers: rows(OF) }, ADMIN, FILE);
      expect([again.created.offers, again.updated.offers]).toEqual([0, 1]);

      const p = await problemsOf(applyImport(tx, input({ offers: rows({ ...OF, brand: 'ceshi-yi', title: '黑名单的优惠' }) }), ADMIN, FILE));
      expect(p.join()).toContain('品牌 ceshi-yi 是黑名单，不能有优惠');
    }));

  it('D-029 优惠：文件内校验（类型 / 基数 / 数字 / 无法计算真实价值）', () => {
    const p = validateImport(
      input({
        offers: rows(
          { brand: 'x', title: '免费旋转 50 次', kind: '免费旋转', rolloverMultiple: '0', rolloverBase: '无', validDays: '7', eligibleGames: '老虎机' },
          { brand: 'x', title: '周返水缺比例', kind: '周返水', rolloverMultiple: '0', rolloverBase: '无', validDays: '7', eligibleGames: '真人百家乐' },
          { brand: 'x', title: '首存彩票', kind: '首存匹配', matchPercent: '1.5', maxBonus: '-1', rolloverMultiple: '10', rolloverBase: '全部', validDays: '7', eligibleGames: '彩票' },
        ),
      }),
    );
    const has = (x: string) => expect(p.some((y) => y.includes(x)), `应包含：${x}\n实际：${p.join('\n')}`).toBe(true);
    has('「优惠」第 4 行：类型只能填');
    has('「优惠」第 5 行：无法计算真实价值：周返水须填返水比例');
    has('「优惠」第 6 行：流水基数只能填');
    has('匹配比例% 须为整数');
    has('「最高奖励」须为不小于 0 的数字');
  });
});
