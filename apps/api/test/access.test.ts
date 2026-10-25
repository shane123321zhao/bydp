/** D-020 #30：后台子域 Access JWT 校验（forward_auth 端点）。本地生成密钥对 + 本地 JWKS，不出网。 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { accessConfigFromEnv, accessVerifier, ACCESS_HEADER, registerAccessCheck } from '../src/access';

const TEAM = 'bydp.cloudflareaccess.com';
const AUD = 'a'.repeat(64);

async function setup() {
  const ours = await generateKeyPair('RS256');
  const theirs = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(ours.publicKey)), kid: 'k1', alg: 'RS256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (o: { aud?: string; iss?: string; exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT({ email: 'po@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? `https://${TEAM}`)
      .setAudience(o.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '10m')
      .sign(o.key ?? ours.privateKey);
  const app = new Hono();
  registerAccessCheck(app, accessVerifier({ team: TEAM, aud: AUD, keys }));
  const hit = async (token?: string) => (await app.request('/internal/access-check', token ? { headers: { [ACCESS_HEADER]: token } } : {})).status;
  return { sign, hit, theirs };
}

describe('Cloudflare Access JWT 校验（#30）', () => {
  it('我方 team 签发且 aud 正确 → 204；缺失 / 他人密钥 / aud 不符 / iss 不符 / 过期 / 乱码 → 403', async () => {
    const { sign, hit, theirs } = await setup();
    expect(await hit(await sign())).toBe(204);
    expect(await hit()).toBe(403);
    expect(await hit(await sign({ key: theirs.privateKey }))).toBe(403);
    expect(await hit(await sign({ aud: 'b'.repeat(64) }))).toBe(403);
    expect(await hit(await sign({ iss: 'https://attacker.cloudflareaccess.com' }))).toBe(403);
    expect(await hit(await sign({ exp: '-1m' }))).toBe(403);
    expect(await hit('not.a.jwt')).toBe(403);
  });

  it('未配置 → 一律 403（失败即关）；配置格式校验', async () => {
    const app = new Hono();
    registerAccessCheck(app, accessVerifier(accessConfigFromEnv({})));
    expect((await app.request('/internal/access-check', { headers: { [ACCESS_HEADER]: 'x.y.z' } })).status).toBe(403);
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, CF_ACCESS_AUD: AUD.toUpperCase() })).toMatchObject({ team: TEAM, aud: AUD });
    expect(() => accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: 'evil.example.com', CF_ACCESS_AUD: AUD })).toThrow(/cloudflareaccess/);
    expect(() => accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: 'short' })).toThrow(/AUD/);
  });
});
