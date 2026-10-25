import 'server-only';
import { MemoryOnceStore, MemoryRateCounter, RedisOnceStore, RedisRateCounter, type OnceStore, type RateCounter } from '@bydp/core/identity/auth';
import { missingAuthDeploymentConfig } from '@bydp/core/identity/authjs';
import Redis from 'ioredis';

/**
 * 登录防护的共享状态（A-009 签核条件 4 + 自检）：magic link 限流计数、TG 登录数据一次性消费。
 * 部署环境（BYDP_ENV=staging|production）必须同时具备（缺一即拒绝启动，见 assertAuthDeployment）：
 *   REDIS_URL（多实例下进程内计数无效）· BYDP_TRUST_PROXY=1（否则取不到真实 IP）· AUTH_URL（防 Host 头投毒）。
 * 本地开发退回进程内实现。
 */
const deployed = () => process.env.BYDP_ENV === 'staging' || process.env.BYDP_ENV === 'production';

export function assertAuthDeployment(env: Record<string, string | undefined> = process.env) {
  const missing = missingAuthDeploymentConfig(env);
  if (missing.length) throw new Error(`部署环境登录配置缺失：${missing.join('、')}`);
}

const g = globalThis as unknown as { __bydpRedis?: Redis; __bydpRate?: RateCounter; __bydpOnce?: OnceStore };
function redis(): Redis | undefined {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  return (g.__bydpRedis ??= new Redis(url, { maxRetriesPerRequest: 2 }));
}

export function rateCounter(): RateCounter {
  assertAuthDeployment();
  const r = redis();
  return (g.__bydpRate ??= r ? new RedisRateCounter(r) : new MemoryRateCounter());
}

export function onceStore(): OnceStore {
  assertAuthDeployment();
  const r = redis();
  return (g.__bydpOnce ??= r ? new RedisOnceStore(r) : new MemoryOnceStore());
}

/** magic link 预期来源：AUTH_URL 的 origin；本地开发（非部署且未设 AUTH_URL）返回 null，只允许 localhost */
export function expectedOrigin(): string | null {
  assertAuthDeployment();
  const u = process.env.AUTH_URL;
  if (u) return new URL(u).origin;
  return deployed() ? '' : null;
}

/** 只有部署在可信反代（Cloudflare → Caddy，源站只接受 Cloudflare 回源）之后才读转发头；否则一律 unknown（可伪造） */
export function clientIp(req: Request | undefined): string {
  if (!req || process.env.BYDP_TRUST_PROXY !== '1') return 'unknown';
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return ip && /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : 'unknown';
}
