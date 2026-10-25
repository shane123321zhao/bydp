/** 站点监控与品牌属性采集（DB 部分需 DATABASE_URL；以 bydp_agent 角色在事务内执行后回滚）。抓取用假 fetcher，不出网 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { collectBrand, extract, pageText } from '../src/collector';
import type { SafeResponse } from '../src/safe-fetch';
import { SafeFetchError } from '../src/safe-fetch';
import { checkIdentifier, registrable, termsHash } from '../src/site-monitor';
import { createPoliteFetcher } from '../src/polite';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url, { max: 1 }) : undefined;
afterAll(async () => conn?.client.end());
const ROLLBACK = new Error('rollback');
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];
async function asAgent<T>(setup: string[], fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  await conn!.db
    .transaction(async (tx) => {
      for (const s of setup) await tx.execute(sql.raw(s));
      await tx.execute(sql`set local role bydp_agent`);
      out = await fn(tx);
      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
  return out;
}
const html = (body: string) => Buffer.from(`<html><head><script>x()</script></head><body>${body}</body></html>`);
const ok = (u: string, body: string, hops?: { url: string; status: number }[]): SafeResponse => ({
  status: 200, url: u, hops: hops ?? [{ url: u, status: 200 }], headers: { 'content-type': 'text/html; charset=utf-8' }, body: html(body), sha256: '',
});
const reviewRows = (tx: Tx, kind: string) =>
  tx.execute(sql`select "subject", "proposal" from "review_item" where "kind" = ${kind} order by "createdAt", "id"`) as unknown as Promise<{ subject: string; proposal: Record<string, unknown> }[]>;

describe('规则抽取', () => {
  it('支付 / 游戏商 / 客服 / 限额；去标签、识别 t.me 链接', () => {
    const t = pageText('<p>充值支持 USDT (TRC20)、银行卡、GCash</p><p>合作：Evolution Gaming、PG Soft、JILI</p><a href="https://t.me/xx_support">客服</a><p>7x24 在线客服</p><p>提款：单笔最高 50,000 USDT，每日 200,000 USDT</p>');
    const e = extract(t);
    expect(e.payment!.values).toEqual(['USDT-TRC20', '银行转账', 'GCash']);
    expect(e.gameProvider!.values).toEqual(['Evolution', 'PG Soft', 'JILI']);
    expect(e.support!.values).toEqual(['Telegram', '24h 在线客服', '在线客服']);
    expect(e.withdrawalLimit!.values).toEqual(['单笔 50,000 USDT', '每日 200,000 USDT']);
    expect(e.payment!.snippet.length).toBeLessThanOrEqual(500);
  });
  it('负例（自检 I5）：促销金额 / 到账时间 / 普通英文词 / Maya slot 不误报；LINE官方客服能识别', () => {
    const e = extract(pageText('<p>LINE官方客服</p><p>The evolution of online gaming in 2024 has changed</p><p>生日礼金 888 元，每日首存送 100 元，最高奖金 88,888 元</p><p>5 min 到账 100 USDT</p><p>Maya slot</p><p>admin 50 USD</p>'));
    expect(e.withdrawalLimit).toBeUndefined();
    expect(e.gameProvider).toBeUndefined();
    expect(e.payment).toBeUndefined();
    expect(e.support!.values).toEqual(['LINE']);
  });
  it('可注册域近似：m. / www / 语言子域同站；两级后缀按三段', () => {
    expect(registrable('m.jinlong88.com')).toBe('jinlong88.com');
    expect(registrable('en.foo.com.my')).toBe('foo.com.my');
    expect(registrable('jl-new.com')).not.toBe(registrable('jinlong88.com'));
  });
  it('条款哈希忽略脚本 / 标签 / 空白差异', () => {
    expect(termsHash('<p>第 1 条  提款</p><script>a</script>')).toBe(termsHash('<div>第 1 条 提款</div>'));
    expect(termsHash('<p>第 1 条 提款</p>')).not.toBe(termsHash('<p>第 1 条 存款</p>'));
  });
});

describe.skipIf(!url)('站点监控（bydp_agent）', () => {
  const IDF = `insert into "identifier" ("id","type","value","ownership") values ('idf_mon','domain','www.mon-test.com','pending')`;
  it('连续 3 次不可达 → offline 提议（robots 拒绝不计）；跳转到新主机 → domain_changed；www 差异不算换域名', async () => {
    const r = await asAgent([IDF], async (tx) => {
      const down = async () => {
        throw new SafeFetchError('timeout', 't');
      };
      const idf = { id: 'idf_mon', value: 'www.mon-test.com', online: true };
      const n = [await checkIdentifier(tx, down, idf), await checkIdentifier(tx, down, idf), await checkIdentifier(tx, down, idf)];
      const moved = async (u: string) =>
        u.startsWith('https://mon-test.com/') && !u.includes('/terms') && !u.includes('/tos')
          ? ok('https://mon-new.com/', '首页', [{ url: u, status: 301 }, { url: 'https://mon-new.com/', status: 200 }])
          : Promise.reject(new SafeFetchError('network', '404'));
      const m = await checkIdentifier(tx, moved, idf);
      const www = async (u: string) => (u.startsWith('https://mon-test.com/') && !/terms|tos/.test(u) ? ok('https://www.mon-test.com/', 'x', [{ url: u, status: 301 }, { url: 'https://www.mon-test.com/', status: 200 }]) : Promise.reject(new Error('404')));
      const w = await checkIdentifier(tx, www, idf);
      const checks = (await tx.execute(sql`select count(*)::int as n from "site_check" where "identifierId" = 'idf_mon' and "kind" = 'home'`)) as unknown as { n: number }[];
      return { n, m, w, rows: await reviewRows(tx, 'site_monitor'), checks: checks[0]!.n };
    });
    expect(r.n).toEqual([0, 0, 1]);
    expect(r.m).toBe(1);
    expect(r.w).toBe(0);
    const by = Object.fromEntries(r.rows.map((x) => [x.subject, x.proposal]));
    expect(Object.keys(by).sort()).toEqual(['idf_mon#domain_changed', 'idf_mon#offline']);
    expect(by['idf_mon#offline']).toMatchObject({ type: 'offline', consecutiveFailures: 3 });
    expect(by['idf_mon#domain_changed']).toMatchObject({ type: 'domain_changed', newHost: 'mon-new.com' });
    expect(r.checks).toBe(5);
  });
  it('端到端（真实礼貌层 + 站点宕机）：robots 与首页都不可达 → 计为失败，连续 3 次产出 offline（自检 B1）；跳到 m. 子域不算换域名', async () => {
    const r = await asAgent([IDF], async (tx) => {
      const dead = createPoliteFetcher({ fetcher: async () => { throw new SafeFetchError('dns', 'nx'); }, sleep: async () => {} });
      const idf = { id: 'idf_mon', value: 'www.mon-test.com', online: true };
      const n = [await checkIdentifier(tx, dead, idf), await checkIdentifier(tx, dead, idf), await checkIdentifier(tx, dead, idf)];
      const sub = async (u: string) => (/terms|tos/.test(u) ? Promise.reject(new Error('404')) : ok('https://m.mon-test.com/', 'x', [{ url: u, status: 302 }, { url: 'https://m.mon-test.com/', status: 200 }]));
      const m = await checkIdentifier(tx, sub, { ...idf, online: false });
      const errs = (await tx.execute(sql`select "error" from "site_check" where "identifierId" = 'idf_mon' and "kind" = 'home' and "error" is not null`)) as unknown as { error: string }[];
      return { n, m, errs: [...new Set(errs.map((e) => e.error))], rows: await reviewRows(tx, 'site_monitor') };
    });
    expect(r.n).toEqual([0, 0, 1]);
    expect(r.errs).toEqual(['dns']);
    expect(r.m).toBe(0);
    expect(r.rows.map((x) => x.subject)).toEqual(['idf_mon#offline']);
  });
  it('条款页哈希变化 → terms_changed；未变化不提；同一新哈希不重复提', async () => {
    const r = await asAgent([IDF], async (tx) => {
      let terms = '<p>第 1 条 提款规则 A</p>';
      const site = async (u: string) => (u.endsWith('/terms') ? ok(u, terms) : u.endsWith('/') ? ok(u, '首页') : Promise.reject(new Error('404')));
      const idf = { id: 'idf_mon', value: 'mon-test.com', online: true };
      const a = await checkIdentifier(tx, site, idf);
      const b = await checkIdentifier(tx, site, idf);
      terms = '<p>第 1 条 提款规则 B（偷改）</p>';
      const c = await checkIdentifier(tx, site, idf);
      const d = await checkIdentifier(tx, site, idf);
      return { counts: [a, b, c, d], rows: await reviewRows(tx, 'site_monitor') };
    });
    expect(r.counts).toEqual([0, 0, 1, 0]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ subject: 'idf_mon#terms_changed', proposal: { type: 'terms_changed', url: 'https://mon-test.com/terms' } });
  });
});

describe.skipIf(!url)('品牌属性采集（bydp_agent）', () => {
  it('官方主域页面 → 各维度提议；与现有值相同不提；同样的值已提过不再提', async () => {
    const r = await asAgent([], async (tx) => {
      const site = async (u: string) =>
        u === 'https://col-test.com/'
          ? ok(u, '<p>充值：USDT TRC20、支付宝</p><p>游戏：Pragmatic Play</p>')
          : u === 'https://col-test.com/faq'
            ? ok(u, '<p>提款单笔最高 10,000 USDT</p><p>Telegram 客服</p>')
            : Promise.reject(new Error('404'));
      const first = await collectBrand(tx, site, { brandId: 'br_royal', domain: 'col-test.com' });
      const again = await collectBrand(tx, site, { brandId: 'br_royal', domain: 'col-test.com' });
      return { first, again, rows: await reviewRows(tx, 'brand_attribute') };
    });
    expect(r.first).toBe(4);
    expect(r.again).toBe(0);
    const by = Object.fromEntries(r.rows.map((x) => [x.subject, x.proposal]));
    expect(by['br_royal:payment']).toMatchObject({ values: ['USDT-TRC20', '支付宝'], sourceUrl: 'https://col-test.com/' });
    expect(by['br_royal:withdrawalLimit']).toMatchObject({ values: ['单笔 10,000 USDT'], sourceUrl: 'https://col-test.com/faq' });
    expect(by['br_royal:support']).toMatchObject({ values: ['Telegram'] });
    expect(by['br_royal:gameProvider']).toMatchObject({ values: ['Pragmatic Play'] });
  });
});
