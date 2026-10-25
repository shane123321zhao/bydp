/**
 * 站点监控（D-016 第 3 项 · §13 v1.12 ②④）：对 domain 类标识定期抓首页与条款页，只经礼貌抓取（robots + 同主机 ≥ 10 秒）与 safe-fetch。
 * 每次抓取写一条 site_check（只存状态 / 最终主机 / 哈希，不存页面内容），据历史产出提议（只写 review_item）：
 * - offline：首页最近连续 ≥ 3 次不可达（网络错误 / 超时 / 5xx / robots.txt 5xx；robots 明确禁止不算）；7 天内已决定过的不再提；
 * - domain_changed：首页跳转后的可注册域与标识不同（www / m. / 语言子域等同站跳转不算）；
 * - terms_changed：同一条款页 URL 的正文（去标签、去空白后）哈希与上一次不同；与首页同哈希（单页应用）不算。
 * 同一对象同类已有待决提议时跳过（部分唯一索引）；同一新主机 / 同一新哈希已提过（任意状态）不再重复提。
 */
import { createHash } from 'node:crypto';
import { sql } from '@bydp/db';
import { normalizeDomain } from '@bydp/entity-graph';
import { proposeReviewItem, type AgentDb } from './db';
import { createPoliteFetcher, RobotsDisallowedError, RobotsUnavailableError } from './polite';
import { SafeFetchError, type SafeResponse } from './safe-fetch';
import { AGENT_SOURCES, expectedSubject, SiteMonitorProposal } from './schemas';

const q = <T>(db: AgentDb, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
type Fetch = (url: string) => Promise<SafeResponse>;

export const SITE_MONITOR = { offlineAfter: 3, recheckHours: 20, batch: 20, budgetMs: 8 * 60_000, termsPaths: ['/terms', '/terms-and-conditions', '/terms-of-service', '/tos'] } as const;

/** 条款正文规范化：去 script / style / 标签与多余空白后求哈希（页面装饰变化不触发） */
export function termsHash(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('hex');
}

const errorOf = (e: unknown): string =>
  e instanceof RobotsDisallowedError
    ? 'robots_disallowed'
    : e instanceof RobotsUnavailableError
      ? `robots_http_${e.status}`
      : e instanceof SafeFetchError
        ? e.reason
        : String((e as Error).message ?? 'error').slice(0, 120);

/** 近似「可注册域」（eTLD+1）：常见两级公共后缀按三段取，其余取末两段。跳到 m. / 语言子域 / CDN 子域不算换域名 */
const TWO_LEVEL = new Set(['com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.my', 'com.ph', 'com.sg', 'com.vn', 'com.au', 'co.uk', 'co.th', 'co.id', 'co.jp', 'co.kr', 'com.br']);
export function registrable(host: string): string {
  const parts = host.split('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
}

async function record(db: AgentDb, r: { identifierId: string; kind: 'home' | 'terms'; url: string; status?: number; finalHost?: string | null; hash?: string | null; error?: string }) {
  await db.execute(
    sql`insert into "site_check" ("id", "identifierId", "kind", "url", "httpStatus", "finalHost", "contentHash", "error")
        values (${`sc_${crypto.randomUUID().replaceAll('-', '')}`}, ${r.identifierId}, ${r.kind}, ${r.url.slice(0, 2048)}, ${r.status ?? null},
                ${r.finalHost ?? null}, ${r.hash ?? null}, ${r.error ? r.error.slice(0, 200) : null})`,
  );
}

async function propose(db: AgentDb, raw: unknown): Promise<boolean> {
  const p = SiteMonitorProposal.safeParse(raw);
  if (!p.success) return false;
  return proposeReviewItem(db, { kind: 'site_monitor', subject: expectedSubject('site_monitor', p.data)!, proposal: p.data, source: AGENT_SOURCES.siteMonitor });
}

/** 检查一个标识：首页（https 失败时退回 http）+ 条款页；返回本次产出的提议数 */
export async function checkIdentifier(db: AgentDb, fetch: Fetch, idf: { id: string; value: string; online: boolean | null }): Promise<number> {
  const host = normalizeDomain(idf.value);
  if (!host) return 0;
  let proposed = 0;
  let home: SafeResponse | null = null;
  let homeUrl = `https://${host}/`;
  let homeError: string | null = null;
  // 原样主机（可能带 www）→ 规范主机 → www → http：只有 www 有解析、或只提供 http 的站点也能判断
  const raw = idf.value.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0]!;
  const attempts = [...new Set([`https://${raw}/`, `https://${host}/`, `https://www.${host}/`, `http://${raw}/`])];
  for (const u of attempts) {
    homeUrl = u;
    try {
      home = await fetch(u);
      homeError = null;
      break;
    } catch (e) {
      homeError = errorOf(e);
      // 地址被拒（SSRF）/ robots 明确禁止：不再换主机或协议
      if (homeError === 'blocked_address' || homeError === 'robots_disallowed') break;
    }
  }
  const finalHost = home ? normalizeDomain(new URL(home.url).hostname) : null;
  await record(db, { identifierId: idf.id, kind: 'home', url: homeUrl, status: home?.status, finalHost, error: home ? undefined : homeError! });

  // offline：最近 N 次首页检查都是失败（robots 拒绝不计入失败，也不计入「成功」）
  const recent = await q<{ httpStatus: number | null; error: string | null }>(
    db,
    sql`select "httpStatus", "error" from "site_check" where "identifierId" = ${idf.id} and "kind" = 'home'
          and coalesce("error", '') <> 'robots_disallowed' order by "checkedAt" desc, "id" desc limit ${SITE_MONITOR.offlineAfter}`,
  );
  const failed = (r: { httpStatus: number | null; error: string | null }) => r.error !== null || (r.httpStatus ?? 0) >= 500;
  // 7 天内已决定过的 offline 提议不再重复提（被驳回后不反复打扰编辑）
  const [decided] = await q<{ id: string }>(
    db,
    sql`select "id" from "review_item" where "kind" = 'site_monitor' and "subject" = ${`${idf.id}#offline`} and "status" <> 'pending' and "decidedAt" > now() - interval '7 days' limit 1`,
  );
  if (!decided && idf.online !== false && recent.length >= SITE_MONITOR.offlineAfter && recent.every(failed)) {
    if (await propose(db, { type: 'offline', identifierId: idf.id, url: homeUrl, consecutiveFailures: recent.length, lastErrors: recent.map((r) => r.error ?? `HTTP ${r.httpStatus}`) })) proposed++;
  }

  // domain_changed：跳转后的最终主机与标识不同（同一新主机已提过则不再提）
  const domainChanged = !!(home && finalHost && registrable(finalHost) !== registrable(host) && home.hops.length > 1 && home.status < 400);
  if (home && finalHost && domainChanged) {
    const [dup] = await q<{ id: string }>(
      db,
      sql`select "id" from "review_item" where "kind" = 'site_monitor' and "subject" = ${`${idf.id}#domain_changed`} and "proposal"->>'newHost' = ${finalHost} limit 1`,
    );
    if (!dup && (await propose(db, { type: 'domain_changed', identifierId: idf.id, url: homeUrl, newHost: finalHost, hops: home.hops.slice(0, 4) }))) proposed++;
  }

  // terms：在最终站点上找第一个可用的条款页（换了域名时不比条款，避免与 domain_changed 叠加；同 URL 才比较哈希）
  if (home && home.status < 400 && !domainChanged) {
    const homeHash = termsHash(home.body.toString('utf8'));
    const origin = new URL(home.url).origin;
    for (const path of SITE_MONITOR.termsPaths) {
      const url = origin + path;
      let r: SafeResponse;
      try {
        r = await fetch(url);
      } catch {
        continue;
      }
      if (r.status !== 200 || !/html|text/i.test(r.headers['content-type'] ?? '')) continue;
      const hash = termsHash(r.body.toString('utf8'));
      if (hash === homeHash) continue; // 单页应用对任意路径都回首页：不是条款页
      const [prev] = await q<{ contentHash: string }>(
        db,
        sql`select "contentHash" from "site_check" where "identifierId" = ${idf.id} and "kind" = 'terms' and "url" = ${url} and "contentHash" is not null order by "checkedAt" desc, "id" desc limit 1`,
      );
      await record(db, { identifierId: idf.id, kind: 'terms', url, status: r.status, finalHost: normalizeDomain(new URL(r.url).hostname), hash });
      if (prev && prev.contentHash !== hash) {
        const [dup] = await q<{ id: string }>(
          db,
          sql`select "id" from "review_item" where "kind" = 'site_monitor' and "subject" = ${`${idf.id}#terms_changed`} and "proposal"->>'currentHash' = ${hash} limit 1`,
        );
        if (!dup && (await propose(db, { type: 'terms_changed', identifierId: idf.id, url, previousHash: prev.contentHash, currentHash: hash }))) proposed++;
      }
      break;
    }
  }
  return proposed;
}

/** 一批：最久未检查的 domain 标识优先；距上次检查不足 recheckHours 的跳过；总时长受预算约束 */
export async function runSiteMonitor(db: AgentDb, opts: { fetch?: Fetch; batch?: number; budgetMs?: number } = {}): Promise<{ checked: number; proposed: number }> {
  const fetch = opts.fetch ?? createPoliteFetcher();
  const started = Date.now();
  const rows = await q<{ id: string; value: string; online: boolean | null }>(
    db,
    sql`select i."id", i."value", i."online" from "identifier" i
        left join lateral (select max(s."checkedAt") as "last" from "site_check" s where s."identifierId" = i."id" and s."kind" = 'home') l on true
        where i."type" = 'domain' and (l."last" is null or l."last" < now() - make_interval(hours => ${SITE_MONITOR.recheckHours}))
        order by l."last" nulls first, i."id" limit ${opts.batch ?? SITE_MONITOR.batch}`,
  );
  let checked = 0;
  let proposed = 0;
  for (const idf of rows) {
    if (Date.now() - started > (opts.budgetMs ?? SITE_MONITOR.budgetMs)) break;
    proposed += await checkIdentifier(db, fetch, idf);
    checked++;
  }
  return { checked, proposed };
}
