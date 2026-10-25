/**
 * POST /v1/postback/{brandId}：运营商转化回传（A-007）。不属公开契约（api-contract 注明「运营商 postback 另行定义」），
 * 故挂普通路由、不进 /v1/openapi.json；运营商对接文档待协调官补。
 * R2：
 * - 请求体 ≤ 64KB（413）；
 * - 限流只计**失败**请求（验签失败 / 被拒）：同 (brandId, 来源 IP) 在窗口内失败超额 → 429，签名正确的运营商不会被攻击者耗尽配额；
 *   来源 IP 默认取 TCP 对端地址，只有显式 trustProxy 时才读 CF-Connecting-IP / X-Forwarded-For（否则可伪造）；
 *   计数表有硬上限，满时淘汰最早的键。进程内实现：多实例部署须换共享存储（Redis），见 to-po；
 * - 非 200 与异常一律记结构化日志（不记正文 / 签名 / 密钥，正文只记 sha256 前 16 位）；我方配置事故记 alert 级。
 * D-008：对外错误——未对接 / 配置缺失 / 验签失败 / 非法 brandId 一律 401 `unauthorized`（防探测商业对接）；
 * 本路由豁免应用层大陆屏蔽（服务器对服务器、HMAC 鉴权、不面向居民；ADR-0007 补注），来自屏蔽地区的请求先记日志再放行。
 */
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { handlePostback } from '@bydp/core/commerce/tracking';
import { MemoryRateCounter, type RateCounter } from '@bydp/core/identity/auth';
import type { Env } from '../app';

export const POSTBACK_MAX_BYTES = 64 * 1024;

export type PostbackLog =
  | { evt: 'postback_rejected'; level: 'warn' | 'alert'; brandId: string; status: number; reason: string; ip: string; bytes: number; bodySha256?: string }
  /** D-008 #1：来自屏蔽地区的回传豁免 451，放行前先记录 */
  | { evt: 'postback_geo_exempt'; level: 'info'; brandId: string; country: string; ip: string };

/** 我方配置事故（密钥缺失 / 引用越界）：对外仍是 401，但须告警——运营商按文档不重试 401，否则静默丢单（审核 D-008 补充） */
const ALERT_REASONS = new Set(['secret_missing', 'secret_ref_invalid']);
export type PostbackOptions = {
  env?: Record<string, string | undefined>;
  /** 每个 (brandId, IP) 每窗口允许的失败次数 */
  rateLimit?: { max: number; windowMs: number };
  /** 失败计数（上线前置 #8：部署环境为 Redis，多实例共享；缺省进程内，用于测试 / 本地） */
  counter?: RateCounter;
  /** 仅当部署在可信反代（Cloudflare）之后才开启：读 CF-Connecting-IP / X-Forwarded-For */
  trustProxy?: boolean;
  /** TCP 对端地址（默认取 @hono/node-server 的 incoming socket；测试可注入） */
  remoteAddr?: (c: Context) => string | undefined;
  log?: (e: PostbackLog) => void;
  now?: () => number;
  /** 应用层屏蔽地区（与 geoBlock 同一份）；来自这些地区的回传豁免 451，但记 postback_geo_exempt */
  geoBlocked?: string[];
};

const BRAND_ID = /^br_[A-Za-z0-9_]{1,64}$/;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;

const socketAddr = (c: Context): string | undefined =>
  (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;

export const POSTBACK_PATH_PREFIX = '/v1/postback/';

export function registerPostback(app: Hono<Env>, opts: PostbackOptions = {}) {
  const { max, windowMs } = opts.rateLimit ?? { max: 60, windowMs: 60_000 };
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((e) => (e.level === 'alert' ? console.error : e.level === 'info' ? console.info : console.warn)(JSON.stringify(e)));
  const remote = opts.remoteAddr ?? socketAddr;
  const counter = opts.counter ?? new MemoryRateCounter(now);
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  const clientIp = (c: Context) => {
    const fromProxy = opts.trustProxy ? (c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()) : undefined;
    const ip = fromProxy ?? remote(c);
    return ip && IP.test(ip) ? ip : 'unknown';
  };
  // 审核 D-015 #2：失败计数是防护不是记账——计数器（Redis）故障时放行（fail-open）并告警，不能因 Redis 宕机丢转化 / 佣金
  const limited = async (key: string, brandId: string, ip: string) => {
    try {
      return (await counter.peek(`pb:${key}`)) >= max;
    } catch (e) {
      log({ evt: 'postback_rejected', level: 'alert', brandId: brandId.slice(0, 80), status: 0, reason: `rate_counter_unavailable_fail_open: ${(e as Error).message.slice(0, 60)}`, ip, bytes: 0 });
      return false;
    }
  };
  const recordFailure = (key: string) => counter.hit(`pb:${key}`, windowSec);

  app.post(
    '/v1/postback/:brandId',
    bodyLimit({
      maxSize: POSTBACK_MAX_BYTES,
      onError: (c) => {
        log({ evt: 'postback_rejected', level: 'warn', brandId: (c.req.param('brandId') ?? '').slice(0, 80), status: 413, reason: 'payload_too_large', ip: clientIp(c), bytes: -1 });
        return c.json({ error: 'payload_too_large' }, 413);
      },
    }),
    async (c) => {
      const brandId = c.req.param('brandId');
      const ip = clientIp(c);
      const key = `${brandId}|${ip}`;
      const reject = async (status: 400 | 401 | 404 | 409 | 429 | 500, reason: string, raw?: string) => {
        log({
          evt: 'postback_rejected',
          level: ALERT_REASONS.has(reason) ? 'alert' : 'warn',
          brandId: brandId.slice(0, 80),
          status,
          reason,
          ip,
          bytes: raw ? Buffer.byteLength(raw) : 0,
          ...(raw ? { bodySha256: createHash('sha256').update(raw).digest('hex').slice(0, 16) } : {}),
        });
        if (status !== 429) await recordFailure(key).catch((e: Error) => log({ evt: 'postback_rejected', level: 'alert', brandId: brandId.slice(0, 80), status, reason: `rate_counter_error: ${e.message.slice(0, 60)}`, ip, bytes: 0 }));
        // D-008 #5：401 对外统一（不区分未对接 / 配置缺失 / 验签失败）；内部问题不透露细节
        const error = status === 401 ? 'unauthorized' : status === 500 ? 'internal' : status === 429 ? 'rate_limited' : reason;
        return c.json({ error }, status);
      };
      const country = c.req.header('CF-IPCountry')?.toUpperCase();
      if (country && opts.geoBlocked?.includes(country)) log({ evt: 'postback_geo_exempt', level: 'info', brandId: brandId.slice(0, 80), country, ip });
      if (!BRAND_ID.test(brandId)) return reject(401, 'bad_brand_id');
      if (await limited(key, brandId, ip)) return reject(429, 'rate_limited');

      const rawBody = await c.req.text();
      try {
        const out = await handlePostback(
          c.get('db'),
          { brandId, timestamp: c.req.header('X-BYDP-Timestamp'), signature: c.req.header('X-BYDP-Signature'), rawBody },
          { env: opts.env },
        );
        if (!out.ok) return reject(out.httpStatus, out.reason, rawBody);
        return c.json({ ok: true, conversion: out.conversion.status }, 200);
      } catch (e) {
        console.error(e);
        return reject(500, 'internal_error', rawBody);
      }
    },
  );
}
