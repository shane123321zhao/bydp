/**
 * D-020 #30（HANDOVER §9 #30 · 审核 D-020 #2–#5 复核第 1 条）：后台子域源站校验 Cloudflare Access JWT。
 * 背景：源站防火墙放行的是全部 Cloudflare 回源段，他人 Cloudflare 账号可把自家域名指向我们的源站 IP 并改写 Host 为后台子域，
 * 从而绕过我们账号里的 Access 策略。只有我们 team 域签发、aud 为后台 Access 应用的 JWT 才放行。
 * - Caddy 后台站点对每个请求 forward_auth 到 `GET /internal/access-check`（只在 compose 内网可达：主站 Caddy 只转发 /v1/*）。
 * - 校验：签名（team 域 JWKS，jose 远程密钥集带缓存）· iss = https://<team 域> · aud = CF_ACCESS_AUD · exp / nbf。
 * - 未配置（CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD）一律 403（失败即关）；正式环境 bootstrap 未配置即拒绝部署。
 * 两个值都不是密钥（team 域名公开、AUD 是应用标识），由 PO 从 Access 应用页复制。
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Hono } from 'hono';

export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';
const TEAM = /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/;
const AUD = /^[a-f0-9]{64}$/;

export type AccessConfig = { team: string; aud: string; keys?: JWTVerifyGetKey };

export function accessConfigFromEnv(env: Record<string, string | undefined> = process.env): AccessConfig | null {
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  const aud = env.CF_ACCESS_AUD?.trim().toLowerCase();
  if (!team || !aud) return null;
  if (!TEAM.test(team)) throw new Error('CF_ACCESS_TEAM_DOMAIN 须形如 <团队名>.cloudflareaccess.com');
  if (!AUD.test(aud)) throw new Error('CF_ACCESS_AUD 须为 Access 应用的 64 位十六进制 AUD');
  return { team, aud };
}

/** 返回 null = 通过；否则为拒绝原因（只用于日志，不回给客户端） */
export function accessVerifier(cfg: AccessConfig | null) {
  const keys = cfg ? (cfg.keys ?? createRemoteJWKSet(new URL(`https://${cfg.team}/cdn-cgi/access/certs`))) : null;
  return async (token: string | undefined): Promise<string | null> => {
    if (!cfg || !keys) return 'not_configured';
    if (!token || token.length > 8192) return 'missing';
    try {
      await jwtVerify(token, keys, { issuer: `https://${cfg.team}`, audience: cfg.aud, algorithms: ['RS256'] });
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? 'invalid';
    }
  };
}

export function registerAccessCheck(app: Hono, verify: (token: string | undefined) => Promise<string | null>) {
  app.get('/internal/access-check', async (c) => {
    const reason = await verify(c.req.header(ACCESS_HEADER));
    if (!reason) return c.body(null, 204);
    console.warn(JSON.stringify({ evt: 'access_jwt_rejected', reason }));
    return c.json({ error: 'forbidden' }, 403);
  });
}
