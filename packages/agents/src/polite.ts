/**
 * 礼貌抓取（架构 §13 v1.12 ④）：在 safe-fetch 之上加 robots.txt 遵守与同主机频率上限（≥ 10 秒间隔）。
 * - robots：按 RFC 9309 解析（User-agent 按产品 token 完整匹配、不区分大小写，空值忽略；专属组优先，否则取 *；
 *   Allow / Disallow 最长匹配，等长 Allow 优先；支持 * 与 $；路径先百分号解码再比较）；结果按 origin 缓存 24 小时。
 *   robots.txt 2xx → 按规则；429 / 5xx → 视为暂不可抓（RobotsUnavailableError，站点监控计为失败）；其他 4xx → 无限制；
 *   网络 / DNS / 超时 → 站点本身不可达，原样抛出 SafeFetchError（不缓存，允许换协议 / 主机重试）。
 * - 重定向逐跳处理：每一跳都检查目标主机的 robots 并遵守同主机间隔（safe-fetch manual 模式，仍每跳做地址校验），最多 3 跳。
 * - 频率：同一主机两次请求之间至少 10 秒（进程内；维护队列并发 1，同一时刻只有一个 Agent 任务在跑）。
 * - 只抓首页与公开页面，不登录、不提交表单。
 */
import { safeFetch, SafeFetchError, SAFE_FETCH_LIMITS, type SafeFetchOptions, type SafeResponse } from './safe-fetch';

export const POLITE = { minHostIntervalMs: 10_000, robotsTtlMs: 24 * 3600_000, agentToken: 'bydp-agent' } as const;

type Rule = { allow: boolean; pattern: string };
type Fetcher = (url: string, o?: SafeFetchOptions) => Promise<SafeResponse>;

/** 解析 robots.txt，返回适用于本 Agent 的规则（产品 token 完整匹配的组优先，否则 *） */
export function parseRobots(txt: string, agentToken: string = POLITE.agentToken): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      if (val) cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && val === '') continue; // 空 Disallow = 不限制
      cur.rules.push({ allow: key === 'allow', pattern: safeDecode(val) });
    }
  }
  const token = agentToken.toLowerCase();
  const mine = groups.filter((g) => g.agents.includes(token));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/** 路径是否允许（最长匹配；等长时 Allow 优先；无匹配 = 允许）。path 先百分号解码 */
export function robotsAllows(rules: Rule[], path: string): boolean {
  const p = safeDecode(path);
  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(r.pattern, p)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** robots 明确禁止该路径 */
export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super('robots.txt 不允许抓取该路径');
    this.name = 'RobotsDisallowedError';
  }
}
/** robots.txt 返回 429 / 5xx：暂不可抓（RFC 9309：按全站禁止处理；站点监控计为失败） */
export class RobotsUnavailableError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`robots.txt 暂不可用（HTTP ${status}）`);
    this.name = 'RobotsUnavailableError';
  }
}

/** 礼貌抓取器（每个任务运行一个实例；fetcher 默认 safeFetch） */
export function createPoliteFetcher(opts: { fetcher?: Fetcher; minHostIntervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const fetcher = opts.fetcher ?? ((u: string, o?: SafeFetchOptions) => safeFetch(u, o));
  const minGap = Math.max(opts.minHostIntervalMs ?? POLITE.minHostIntervalMs, 0);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastHit = new Map<string, number>();
  const robots = new Map<string, { rules: Rule[] | { unavailable: number }; at: number }>();

  async function gate(host: string) {
    const last = lastHit.get(host);
    if (last !== undefined) {
      const wait = last + minGap - now();
      if (wait > 0) await sleep(wait);
    }
    lastHit.set(host, now());
  }

  async function rulesFor(url: URL): Promise<Rule[] | { unavailable: number }> {
    const key = url.origin;
    const c = robots.get(key);
    if (c && now() - c.at < POLITE.robotsTtlMs) return c.rules;
    await gate(url.host);
    // 网络 / DNS / 超时：站点不可达，原样抛出（不缓存）
    const r = await fetcher(new URL('/robots.txt', url).toString(), { maxBytes: 512 * 1024 });
    const rules: Rule[] | { unavailable: number } =
      r.status === 429 || r.status >= 500 ? { unavailable: r.status } : r.status >= 400 || r.status >= 300 ? [] : parseRobots(r.body.toString('utf8'));
    robots.set(key, { rules, at: now() });
    return rules;
  }

  async function checkAndGate(url: URL) {
    const rules = await rulesFor(url);
    if (!Array.isArray(rules)) throw new RobotsUnavailableError(url.toString(), rules.unavailable);
    if (!robotsAllows(rules, url.pathname + url.search)) throw new RobotsDisallowedError(url.toString());
    await gate(url.host);
  }

  return async function politeFetch(rawUrl: string, o: SafeFetchOptions = {}): Promise<SafeResponse> {
    let url = new URL(rawUrl);
    const hops: { url: string; status: number }[] = [];
    for (let hop = 0; ; hop++) {
      await checkAndGate(url);
      const r = await fetcher(url.toString(), { ...o, redirect: 'manual' });
      hops.push({ url: url.toString(), status: r.status });
      const loc = r.headers.location;
      if (r.status >= 300 && r.status < 400 && loc) {
        if (hop >= SAFE_FETCH_LIMITS.maxRedirects) throw new SafeFetchError('too_many_redirects', `重定向超过 ${SAFE_FETCH_LIMITS.maxRedirects} 跳`);
        try {
          url = new URL(loc, url);
        } catch {
          throw new SafeFetchError('protocol', '重定向地址无法解析');
        }
        continue;
      }
      return { ...r, url: url.toString(), hops };
    }
  };
}
