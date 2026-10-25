/** A-009 规则的静态与配置断言：eslint 拦截 identity / verification_token 旁路写入；部署环境登录必需配置 */
/* eslint-disable no-restricted-syntax -- 规则 fixture：本文件故意写违规 SQL 字符串以验证拦截生效 */
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { missingAuthDeploymentConfig } from '../src/identity/authjs';

const ROOT = join(import.meta.dirname, '../../..');
const eslint = new ESLint({ cwd: ROOT });
const lint = async (code: string, file = 'apps/api/src/__probe__.ts') => {
  const [r] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return r!.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
};

describe('eslint：identity / verification_token 写入只经 core identity/auth（审核：userId 只能经合并用例改）', () => {
  it.each([
    'export const q = `update "identity" set "userId" = 1`;',
    'export const q = "UPDATE public.identity SET x = 1";',
    'export const q = `update "public"."identity" set "userId" = 1`;',
    'export const q = "delete from verification_token where true";',
    'export const q = `insert into "verification_token" values (1)`;',
    "import { identities } from '@bydp/db/schema'; export const t = identities;",
    "import { schema } from '@bydp/db'; export const t = schema.verificationTokens;",
  ])('拦截：%s', async (code) => {
    expect((await lint(code)).join()).toMatch(/A-009/);
  });

  it('不误伤：读 identity_provider 枚举 / 普通 select；入口文件自身豁免', async () => {
    expect(await lint('export const q = "select * from identity_provider";')).toEqual([]);
    expect(await lint('export const q = `select "handle" from "identity"`;')).toEqual([]);
  });
});

describe('部署环境登录必需配置（自检阻塞 1 / 2）', () => {
  it('staging / production 缺 AUTH_URL（须 https）/ REDIS_URL / BYDP_TRUST_PROXY=1 → 列出；本地不要求', () => {
    expect(missingAuthDeploymentConfig({})).toEqual([]);
    expect(missingAuthDeploymentConfig({ BYDP_ENV: 'staging' })).toEqual(['AUTH_URL（https）', 'REDIS_URL', 'BYDP_TRUST_PROXY=1']);
    expect(missingAuthDeploymentConfig({ BYDP_ENV: 'production', AUTH_URL: 'http://northx.vip', REDIS_URL: 'redis://r', BYDP_TRUST_PROXY: '1' })).toEqual(['AUTH_URL（https）']);
    expect(missingAuthDeploymentConfig({ BYDP_ENV: 'staging', AUTH_URL: 'https://northx.vip', REDIS_URL: 'redis://r', BYDP_TRUST_PROXY: '1' })).toEqual([]);
  });
});
