/**
 * 品牌属性采集（D-016 第 2 项 · §13 v1.12 ②④）：抓品牌**官方主域**（identifier.primary）的首页与常见公开页面，
 * 用规则（关键词词典 + 正则）抽取支付方式 / 提款限额 / 客服渠道 / 游戏商 → brand_attribute 提议（只写 review_item）。
 * 只经礼貌抓取（robots + 同主机 ≥ 10 秒）与 safe-fetch；不登录、不提交表单；LLM 补充字段仅 AGENT_LLM_ENABLED=1 时（本轮未接入）。
 * 与现有属性值相同（忽略大小写与顺序）或同样的值已提过（任意状态）则不再提议。
 */
import { sql } from '@bydp/db';
import { normalizeDomain } from '@bydp/entity-graph';
import { proposeReviewItem, type AgentDb } from './db';
import { createPoliteFetcher } from './polite';
import type { SafeResponse } from './safe-fetch';
import { AGENT_SOURCES, BrandAttributeProposal, expectedSubject } from './schemas';

const q = <T>(db: AgentDb, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;
type Fetch = (url: string) => Promise<SafeResponse>;
type Dimension = 'payment' | 'withdrawalLimit' | 'support' | 'gameProvider';

export const COLLECTOR = { paths: ['/', '/deposit', '/payment', '/banking', '/faq', '/help'], maxPagesPerBrand: 4, batch: 50, budgetMs: 8 * 60_000 } as const;

/** 词典：[规范名, 匹配正则]。规范名即落地值（与 fixtures 写法一致） */
const DICT: Record<Exclude<Dimension, 'withdrawalLimit'>, [string, RegExp][]> = {
  payment: [
    ['USDT-TRC20', /usdt[\s_-]*\(?trc[\s-]?20\)?|trc[\s-]?20/i],
    ['USDT-ERC20', /usdt[\s_-]*\(?erc[\s-]?20\)?|erc[\s-]?20/i],
    ['银行转账', /银行(卡|转账)|網銀|网银|bank\s*transfer/i],
    ['支付宝', /支付宝|支付寶|alipay/i],
    ['微信支付', /微信支付|wechat\s*pay/i],
    ['GCash', /\bgcash\b/i],
    ['Maya', /\bpay\s?maya\b|\bmaya\b(?=[^.。\n]{0,20}(wallet|e-?wallet|pay|充值|支付|存款))/i],
    ['GrabPay', /\bgrab\s?pay\b/i],
    ["Touch 'n Go", /touch\s*['’]?\s*n\s*go/i],
    ['DuitNow', /\bduitnow\b/i],
    ['PromptPay', /\bpromptpay\b/i],
    ['BTC', /\bbitcoin\b|\bbtc\b/i],
  ],
  gameProvider: [
    ['Evolution', /\bevolution\s+gaming\b|\bevolution\b(?=[^.。\n]{0,30}(live|casino|真人))|EVO真人/i],
    ['Pragmatic Play', /\bpragmatic\s*play\b/i],
    ['PG Soft', /\bpg\s*soft\b|\bpocket\s*games\s*soft\b/i],
    ['JILI', /\bjili\b/i],
    ['SA Gaming', /\bsa\s*gaming\b/i],
    ['AG', /\basia\s*gaming\b|AG真人/i],
    ['Fa Chai', /\bfa\s*chai\b/i],
    ['Microgaming', /\bmicrogaming\b/i],
    ['Playtech', /\bplaytech\b/i],
    ['NetEnt', /\bnetent\b/i],
    ['CQ9', /\bcq9\b/i],
    ['JDB', /\bjdb\b/i],
    ['Habanero', /\bhabanero\b/i],
  ],
  support: [
    ['Telegram', /\btelegram\b|\bt\.me\//i],
    ['WhatsApp', /\bwhatsapp\b/i],
    ['LINE', /\bline\b\s*(id\b|官方|@)|line\.me\//i],
    ['24h 在线客服', /(\b24\s*(h|hours?)\b|24\s*(小时|小時)|7\s*[x×]\s*24)[^。.\n]{0,8}(客服|support|服务|服務)|(客服|support)[^。.\n]{0,8}(\b24\s*(h|hours?)\b|24\s*(小时|小時)|7\s*[x×]\s*24)/i],
    ['在线客服', /在线客服|在線客服|live\s*chat/i],
  ],
};
// 不用单字标签；min / max 要词边界。命中后再看前 40 字内是否有「提款 / 提现 / 出款 / withdraw」语境，避免把优惠金额、到账时间当成限额
const LIMIT_RE = /(单笔|單筆|每日|每天|最低|最高|daily|per\s+transaction|\bmin(?:imum)?\b|\bmax(?:imum)?\b)[^\d\n]{0,12}(\d[\d,]*(?:\.\d+)?)\s*(USDT|USD|CNY|RMB|元|PHP|MYR|THB)/gi;
const WITHDRAW_CTX = /提款|提现|提現|出款|withdraw/i;

/** 页面 HTML → 可读文本（去 script / style / 标签；保留 href 以识别 t.me 链接） */
export function pageText(html: string): string {
  const hrefs = [...html.matchAll(/href=["']([^"']{1,200})["']/gi)].map((m) => m[1]).join(' ');
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim() +
    ' ' +
    hrefs
  );
}

/** 从文本抽取各维度的值与首个命中片段 */
export function extract(text: string): Partial<Record<Dimension, { values: string[]; snippet: string }>> {
  const out: Partial<Record<Dimension, { values: string[]; snippet: string }>> = {};
  const around = (i: number) => text.slice(Math.max(0, i - 150), i + 250).trim().slice(0, 500);
  for (const dim of Object.keys(DICT) as (keyof typeof DICT)[]) {
    const values: string[] = [];
    let first = -1;
    for (const [name, re] of DICT[dim]) {
      const m = re.exec(text);
      if (m) {
        values.push(name);
        if (first < 0 || m.index < first) first = m.index;
      }
    }
    if (values.length) out[dim] = { values, snippet: around(first) };
  }
  const limits: string[] = [];
  let firstLimit = -1;
  for (const m of text.matchAll(LIMIT_RE)) {
    const at = m.index ?? 0;
    if (!WITHDRAW_CTX.test(text.slice(Math.max(0, at - 40), at))) continue;
    const label = m[1]!;
    const amount = m[2]!;
    const unit = m[3]!.toUpperCase() === '元' ? 'CNY' : m[3]!.toUpperCase();
    limits.push(`${label} ${amount} ${unit}`);
    if (firstLimit < 0) firstLimit = m.index ?? 0;
    if (limits.length >= 5) break;
  }
  if (limits.length) out.withdrawalLimit = { values: limits, snippet: around(firstLimit) };
  return out;
}

const sameSet = (a: string[], b: string[]) => {
  const n = (xs: string[]) => [...new Set(xs.map((x) => x.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()))].sort().join('|');
  return n(a) === n(b);
};

/** 采集一个品牌（官方主域）；返回提议数 */
export async function collectBrand(db: AgentDb, fetch: Fetch, b: { brandId: string; domain: string }): Promise<number> {
  const host = normalizeDomain(b.domain);
  if (!host) return 0;
  const found = new Map<Dimension, { values: string[]; snippet: string; url: string }>();
  // 首页：规范主机 → www → 原样主机（只有 www 有解析的站点也能采）；首页都不可得就不抓其他页
  const raw = b.domain.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0]!;
  let base: string | null = null;
  let homeResp: SafeResponse | null = null;
  for (const origin of [...new Set([`https://${host}`, `https://www.${host}`, `https://${raw}`])]) {
    try {
      homeResp = await fetch(`${origin}/`);
      base = new URL(homeResp.url).origin;
      break;
    } catch {
      continue;
    }
  }
  if (!base || !homeResp) return 0;
  let pages = 0;
  for (const path of COLLECTOR.paths) {
    if (pages >= COLLECTOR.maxPagesPerBrand) break;
    let r: SafeResponse;
    if (path === '/') r = homeResp;
    else {
      try {
        r = await fetch(`${base}${path}`);
      } catch {
        continue;
      }
    }
    pages++;
    if (r.status !== 200 || !/html|text/i.test(r.headers['content-type'] ?? '')) continue;
    const ext = extract(pageText(r.body.toString('utf8')));
    for (const [dim, v] of Object.entries(ext) as [Dimension, { values: string[]; snippet: string }][]) {
      const cur = found.get(dim);
      if (!cur) found.set(dim, { ...v, url: r.url });
      else cur.values = [...new Set([...cur.values, ...v.values])];
    }
  }
  let proposed = 0;
  const fetchedAt = new Date().toISOString();
  for (const [dimension, v] of found) {
    const [existing] = await q<{ values: string[] }>(db, sql`select "values" from "brand_attribute" where "brandId" = ${b.brandId} and "dimension" = ${dimension}`);
    // 与现有值相同、或只是现有值的子集（页面没列全）→ 不提议（不让 Agent 提「删减」）
    const norm = (x: string) => x.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (existing && v.values.every((x) => existing.values.some((e) => norm(e) === norm(x)))) continue;
    const raw = { brandId: b.brandId, dimension, values: v.values.slice(0, 30), sourceUrl: v.url, fetchedAt, snippet: v.snippet || undefined };
    const p = BrandAttributeProposal.safeParse(raw);
    if (!p.success) continue;
    const subject = expectedSubject('brand_attribute', p.data)!;
    // 同样的值提过（任意状态，含已驳回）不再提
    const prior = await q<{ values: string[] }>(
      db,
      sql`select array(select jsonb_array_elements_text("proposal"->'values')) as "values" from "review_item" where "kind" = 'brand_attribute' and "subject" = ${subject}`,
    );
    if (prior.some((x) => sameSet(x.values, p.data.values))) continue;
    if (await proposeReviewItem(db, { kind: 'brand_attribute', subject, proposal: p.data, source: AGENT_SOURCES.collector })) proposed++;
  }
  return proposed;
}

/** 一批：有官方主域的品牌（黑名单除外） */
export async function runCollector(db: AgentDb, opts: { fetch?: Fetch; batch?: number; budgetMs?: number } = {}): Promise<{ brands: number; proposed: number }> {
  const fetch = opts.fetch ?? createPoliteFetcher();
  const started = Date.now();
  const rows = await q<{ brandId: string; domain: string }>(
    db,
    // 官方域名口径同 field-mapping：Identifier(type = domain, ownership = official, primary = true)；按日轮转顺序，品牌多于一批时逐日覆盖
    sql`select b."id" as "brandId", i."value" as "domain" from "brand" b
        join "identifier" i on i."brandId" = b."id" and i."primary" and i."type" = 'domain' and i."ownership" = 'official'
        where b."status" <> 'blacklist' order by md5(b."id" || current_date::text) limit ${opts.batch ?? COLLECTOR.batch}`,
  );
  let brands = 0;
  let proposed = 0;
  for (const b of rows) {
    if (Date.now() - started > (opts.budgetMs ?? COLLECTOR.budgetMs)) break;
    proposed += await collectBrand(db, fetch, b);
    brands++;
  }
  return { brands, proposed };
}
