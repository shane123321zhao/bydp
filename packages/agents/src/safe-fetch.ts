/**
 * Agent 唯一出网入口（审核 A-017 条件 1 · D-016 阻断项 · 架构 §13 ④）。全部 Agent 抓取只能经本模块（lint 禁止直接 fetch / http）。
 * SSRF 防护：
 * - 只允许 http / https，端口只允许 80 / 443（URL 中的 IP 字面量同样走地址校验；用户名密码段拒绝）；
 * - 自行做 DNS 解析，**全部**解析结果都须是公网地址，否则拒绝（私网 / 回环 / 链路本地含 169.254.169.254 / CGNAT / 组播 / 保留 / 文档段，v4 + v6，
 *   含 v4 映射 / NAT64 / 6to4 内嵌的 v4）；连接时**锁定**校验过的 IP（自定义 lookup 只返回该 IP），防 DNS rebinding；
 * - 重定向不自动跟随：每一跳重新做协议 / 端口 / 解析 / 地址校验，最多 3 跳；
 * - 总超时 ≤ 10 秒，响应体上限 2MB（超出即中止）；只取正文用于哈希 / 解析，不执行任何内容；
 * - UA 标明 BYDP。robots 与同主机频率限制见 polite.ts（在本模块之上）。
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net, { BlockList, isIP } from 'node:net';

export const SAFE_FETCH_LIMITS = { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3 } as const;
export const AGENT_USER_AGENT = 'BYDP-Agent/0.1 (+https://northx.vip/bot; trust research, no login)';

export class SafeFetchError extends Error {
  constructor(
    public readonly reason: 'protocol' | 'port' | 'credentials' | 'blocked_address' | 'dns' | 'too_many_redirects' | 'timeout' | 'too_large' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

/** 禁止访问的地址段（v4 + v6）。依据 IANA 特殊用途地址注册表 */
function buildBlockList(): BlockList {
  const b = new BlockList();
  for (const [net4, len] of [
    ['0.0.0.0', 8], // 本网络
    ['10.0.0.0', 8], // 私网
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8], // 回环
    ['169.254.0.0', 16], // 链路本地（含云厂商元数据 169.254.169.254）
    ['172.16.0.0', 12], // 私网（含 docker 默认网段）
    ['192.0.0.0', 24], // IETF 协议分配
    ['192.0.2.0', 24], // 文档 TEST-NET-1
    ['192.88.99.0', 24], // 6to4 中继任播
    ['192.168.0.0', 16], // 私网
    ['198.18.0.0', 15], // 基准测试
    ['198.51.100.0', 24], // 文档 TEST-NET-2
    ['203.0.113.0', 24], // 文档 TEST-NET-3
    ['224.0.0.0', 4], // 组播
    ['240.0.0.0', 4], // 保留（含 255.255.255.255）
    ['168.63.129.16', 32], // Azure 平台宿主地址（公网段，但属云内部服务）
  ] as const)
    b.addSubnet(net4, len, 'ipv4');
  for (const [net6, len] of [
    ['::', 128], // 未指定
    ['::1', 128], // 回环
    ['100::', 64], // 丢弃前缀
    ['2001::', 23], // IETF 协议分配（含 Teredo 2001::/32）
    ['2001:db8::', 32], // 文档
    ['fc00::', 7], // ULA 私网
    ['fe80::', 10], // 链路本地
    ['fec0::', 10], // 站点本地（已废弃）
    ['ff00::', 8], // 组播
    ['64:ff9b:1::', 48], // 本地 NAT64（RFC 8215）：内嵌 v4 的布局不固定，整段封禁（审核 D-016 第 1 轮 ①）
    ['5f00::', 16], // SRv6 SID（RFC 9602）
    ['3fff::', 20], // 文档（RFC 9637）
  ] as const)
    b.addSubnet(net6, len, 'ipv6');
  return b;
}
const BLOCK = buildBlockList();

/** v6 地址里内嵌的 v4（v4 映射 ::ffff:a.b.c.d、v4 兼容、NAT64 64:ff9b::/96、6to4 2002::/16）——取出后按 v4 规则判 */
function embeddedV4(addr: string): string | null {
  const lower = addr.toLowerCase();
  const dotted = lower.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  const groups = expandV6(lower);
  if (!groups) return dotted ? dotted[1]! : null;
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (zeros(5) && groups[5] === 0xffff) return toV4(groups[6]!, groups[7]!); // ::ffff:0:0/96
  if (zeros(6)) return toV4(groups[6]!, groups[7]!); // ::/96 v4 兼容
  if (zeros(4) && groups[4] === 0xffff && groups[5] === 0) return toV4(groups[6]!, groups[7]!); // ::ffff:0:0:0/96 SIIT
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return toV4(groups[6]!, groups[7]!); // 64:ff9b::/96
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return toV4(groups[6]!, groups[7]!); // 64:ff9b:1::/48 本地 NAT64（RFC 8215，常见 /96 布局）
  if (groups[0] === 0x2002) return toV4(groups[1]!, groups[2]!); // 6to4
  return null;
}

function expandV6(addr: string): number[] | null {
  let a = addr.split('%')[0]!;
  const dotted = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number);
    a = a.slice(0, -dotted[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  const all = [...h, ...Array(tail !== undefined ? fill : 0).fill('0'), ...t];
  const nums = all.map((g) => parseInt(g || '0', 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

/** 地址是否禁止访问（非法格式一律视为禁止） */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return BLOCK.check(addr, 'ipv4');
  if (v === 6) {
    const v4 = embeddedV4(addr);
    if (v4 && isIP(v4) === 4 && BLOCK.check(v4, 'ipv4')) return true;
    return BLOCK.check(addr, 'ipv6');
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** 公开参数：只能收紧（方法 / 更短时限 / 更小上限），不能改变地址与端口策略 */
export type SafeFetchOptions = {
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
  /** manual：不跟随重定向，原样返回 3xx（礼貌层逐跳检查 robots 与同主机间隔后再请求下一跳）；默认 follow（≤ 3 跳） */
  redirect?: 'follow' | 'manual';
};

/** 仅测试可用的注入（审核 D-016 第 1 轮 ②）：非 test 环境调用直接抛错；lint 禁止 src 内引用 safeFetchWithTestHooks */
export type SafeFetchTestHooks = {
  resolve?: Resolver;
  isBlocked?: (addr: string) => boolean;
  allowedPorts?: readonly number[];
};

export type SafeResponse = {
  status: number;
  /** 最终 URL（跟随重定向之后） */
  url: string;
  /** 每一跳（含首个请求）的 URL 与状态，供 site_monitor 判断换域名 */
  hops: { url: string; status: number }[];
  headers: Record<string, string>;
  body: Buffer;
  sha256: string;
};

/** 校验 URL 并解析出一个可连接的公网 IP（全部解析结果都须公网；锁定第一个） */
async function vet(url: URL, o: Required<SafeFetchTestHooks>, deadline: number): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('protocol', `不允许的协议 ${url.protocol}`);
  if (url.username || url.password) throw new SafeFetchError('credentials', 'URL 不得含用户名 / 密码');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!o.allowedPorts.includes(port)) throw new SafeFetchError('port', `不允许的端口 ${port}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    // DNS 也受总时限约束（自检 S1）：慢解析不能把一次抓取拖过 10 秒
    let timer: NodeJS.Timeout | undefined;
    try {
      addrs = await Promise.race([
        o.resolve(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SafeFetchError('timeout', 'DNS 解析超时')), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch (e) {
      throw e instanceof SafeFetchError ? e : new SafeFetchError('dns', `无法解析 ${host}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!addrs.length) throw new SafeFetchError('dns', `无法解析 ${host}`);
  const bad = addrs.find((a) => o.isBlocked(a));
  if (bad !== undefined) throw new SafeFetchError('blocked_address', `目标地址不允许访问（${host} → 非公网地址）`);
  return addrs[0]!;
}

function requestOnce(url: URL, ip: string, method: string, deadline: number, maxBytes: number): Promise<Omit<SafeResponse, 'url' | 'hops' | 'sha256'>> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SafeFetchError('timeout', '抓取超时'));
    const mod = url.protocol === 'https:' ? https : http;
    // 锁定 IP：自定义 lookup 只返回已校验的地址（TLS 的 SNI / 证书校验仍按主机名）
    const family = net.isIP(ip);
    const req = mod.request(
      url,
      {
        method,
        headers: { 'User-Agent': AGENT_USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity' },
        lookup: (_h, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: ip, family }]);
          else cb(null, ip, family);
        },
        agent: false,
        timeout: remaining,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new SafeFetchError('too_large', `响应超过 ${maxBytes} 字节`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', (e) => reject(e instanceof SafeFetchError ? e : new SafeFetchError('network', e.message)));
      },
    );
    const timer = setTimeout(() => req.destroy(new SafeFetchError('timeout', '抓取超时')), remaining);
    req.on('timeout', () => req.destroy(new SafeFetchError('timeout', '抓取超时')));
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e instanceof SafeFetchError ? e : new SafeFetchError('network', e.message));
    });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** 安全抓取：返回最终响应（含每一跳）；任何一步不满足即抛 SafeFetchError */
export function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  // 只取白名单字段，忽略任何多传的属性（防止以 as never 等方式把测试注入带进生产调用）
  return run(rawUrl, { method: options.method, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, redirect: options.redirect }, {});
}

export function safeFetchWithTestHooks(rawUrl: string, options: SafeFetchOptions, hooks: SafeFetchTestHooks): Promise<SafeResponse> {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) throw new Error('safeFetchWithTestHooks 只能在测试中使用');
  return run(rawUrl, options, hooks);
}

async function run(rawUrl: string, options: SafeFetchOptions, hooks: SafeFetchTestHooks): Promise<SafeResponse> {
  const o = {
    method: options.method ?? 'GET',
    resolve: hooks.resolve ?? systemResolver,
    isBlocked: hooks.isBlocked ?? isBlockedAddress,
    allowedPorts: hooks.allowedPorts ?? [80, 443],
    timeoutMs: Math.min(options.timeoutMs ?? SAFE_FETCH_LIMITS.timeoutMs, SAFE_FETCH_LIMITS.timeoutMs),
    maxBytes: Math.min(options.maxBytes ?? SAFE_FETCH_LIMITS.maxBytes, SAFE_FETCH_LIMITS.maxBytes),
  };
  const deadline = Date.now() + o.timeoutMs;
  const hops: { url: string; status: number }[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('protocol', 'URL 无法解析');
  }
  for (let hop = 0; ; hop++) {
    const ip = await vet(url, o, deadline);
    const res = await requestOnce(url, ip, o.method, deadline, o.maxBytes);
    hops.push({ url: url.toString(), status: res.status });
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc && options.redirect !== 'manual') {
      if (hop >= SAFE_FETCH_LIMITS.maxRedirects) throw new SafeFetchError('too_many_redirects', `重定向超过 ${SAFE_FETCH_LIMITS.maxRedirects} 跳`);
      try {
        url = new URL(loc, url); // 下一跳重新校验协议 / 端口 / 解析 / 地址
      } catch {
        throw new SafeFetchError('protocol', '重定向地址无法解析'); // 自检 S2：非法 Location 不抛裸 TypeError
      }
      continue;
    }
    return { ...res, url: url.toString(), hops, sha256: createHash('sha256').update(res.body).digest('hex') };
  }
}
