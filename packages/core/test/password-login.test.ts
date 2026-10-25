/** D-034：后台账号密码登录（纯逻辑，假计数器 / 假查库）。正确 / 错误密码、非白名单、开关关闭、正式环境拒绝、限流与锁定、计数器故障。 */
import { describe, expect, it } from 'vitest';
import { MemoryRateCounter, type RateCounter } from '../src/identity/auth';
import { authorizePasswordLogin, hashPassword, passwordLoginConfigFromEnv, verifyPassword, type PasswordLoginEvent } from '../src/identity/password-login';

const PW = 'test-only-password-0001';
const HASH = hashPassword(PW);
const EMAIL = 'demo.client@gmail.com';
const env = (o: Record<string, string>) => ({ BYDP_ENV: 'staging', ADMIN_PASSWORD_LOGIN: 'on', ADMIN_PASSWORD_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: HASH, ...o });

function setup(counter: RateCounter = new MemoryRateCounter(), config = passwordLoginConfigFromEnv(env({}))) {
  const events: PasswordLoginEvent[] = [];
  const deps = { config, counter, findUserId: async (e: string) => (e === EMAIL ? 'u_demo' : null), epochOf: async () => 3, audit: async (e: PasswordLoginEvent) => void events.push(e) };
  const login = (email: string, password: string, ip = '203.0.113.9') => authorizePasswordLogin(deps, { email, password, ip });
  return { login, events };
}

describe('后台账号密码登录', () => {
  it('哈希：scrypt 格式、随机盐、校验正确 / 错误', () => {
    expect(HASH).toMatch(/^scrypt:32768:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(HASH).not.toContain('$'); // .env.prod 会被 bash source / compose 插值
    expect(hashPassword(PW)).not.toBe(HASH);
    expect(verifyPassword(PW, HASH)).toBe(true);
    expect(verifyPassword('wrong', HASH)).toBe(false);
    expect(verifyPassword(PW, 'not-a-hash')).toBe(false);
  });

  it('配置：只有 on + 非正式环境 + 邮箱与哈希合规才启用', () => {
    expect(passwordLoginConfigFromEnv(env({}))).toEqual({ email: EMAIL, hash: HASH });
    expect(passwordLoginConfigFromEnv(env({ BYDP_ENV: 'production' }))).toBeNull();
    expect(passwordLoginConfigFromEnv(env({ ADMIN_PASSWORD_LOGIN: 'off' }))).toBeNull();
    expect(passwordLoginConfigFromEnv({ BYDP_ENV: 'staging', ADMIN_PASSWORD_EMAIL: EMAIL, ADMIN_PASSWORD_HASH: HASH })).toBeNull();
    expect(passwordLoginConfigFromEnv(env({ ADMIN_PASSWORD_HASH: 'plain-text' }))).toBeNull();
  });

  it('正确密码 → 会话主体（uid / epoch），邮箱大小写与首尾空格不敏感；写成功 audit（不含密码）', async () => {
    const { login, events } = setup();
    expect(await login(' Demo.Client@gmail.com ', PW)).toEqual({ id: 'u_demo', epoch: 3 });
    expect(events).toEqual([{ ok: true, reason: 'success', userId: 'u_demo', ip: '203.0.113.9' }]);
    expect(JSON.stringify(events)).not.toContain(PW);
  });

  it('错误密码 / 非白名单邮箱 / 开关关闭 → 拒绝并记失败原因', async () => {
    const { login, events } = setup();
    expect(await login(EMAIL, 'wrong')).toBeNull();
    expect(await login('someone.else@gmail.com', PW)).toBeNull();
    expect(events.map((e) => e.reason)).toEqual(['bad_password', 'not_allowed']);
    const off = setup(new MemoryRateCounter(), null);
    expect(await off.login(EMAIL, PW)).toBeNull();
    expect(off.events.map((e) => e.reason)).toEqual(['disabled']);
  });

  it('每 IP 每分钟 ≤ 5 次：第 6 次即使密码正确也拒绝；其他 IP 不受影响', async () => {
    const { login, events } = setup();
    for (let i = 0; i < 5; i++) await login(EMAIL, 'wrong', '198.51.100.1');
    expect(await login(EMAIL, PW, '198.51.100.1')).toBeNull();
    expect(events.at(-1)!.reason).toBe('rate_limited');
    expect(await login(EMAIL, PW, '198.51.100.2')).toEqual({ id: 'u_demo', epoch: 3 });
  });

  it('该账号 1 小时失败 20 次 → 锁定（正确密码也拒绝）', async () => {
    const counter = new MemoryRateCounter();
    const { login, events } = setup(counter);
    for (let i = 0; i < 20; i++) await login(EMAIL, 'wrong', `10.0.${Math.floor(i / 5)}.${i}`);
    expect(await login(EMAIL, PW, '10.9.9.9')).toBeNull();
    expect(events.at(-1)!.reason).toBe('locked');
  });

  it('计数器故障 → 拒绝（失败即关）', async () => {
    const broken: RateCounter = { hit: () => Promise.reject(new Error('redis down')), add: () => Promise.reject(new Error('x')), peek: () => Promise.reject(new Error('x')) };
    const { login, events } = setup(broken);
    expect(await login(EMAIL, PW)).toBeNull();
    expect(events.map((e) => e.reason)).toEqual(['counter_unavailable']);
  });
});
