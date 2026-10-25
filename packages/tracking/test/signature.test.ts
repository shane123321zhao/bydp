import { sql } from '@bydp/db';
import { describe, expect, it } from 'vitest';
import { loadPostbackIntegration, signPostback, verifyPostbackSignature } from '../src/index';
import { asApp, inTx, url } from './helpers';

const SECRET = 's'.repeat(40);
const NOW = 1_790_000_000_000;
const TS = String(NOW / 1000);
const BODY = '{"externalEventId":"e1","event":"register","operatorAccountId":"A"}';

describe('verifyPostbackSignature', () => {
  const base = { secret: SECRET, timestamp: TS, rawBody: BODY, windowSec: 300, nowMs: NOW };
  it('通过（含 sha256= 前缀、大写 hex）', () => {
    const sig = signPostback(SECRET, TS, BODY);
    expect(verifyPostbackSignature({ ...base, signature: sig })).toEqual({ ok: true });
    expect(verifyPostbackSignature({ ...base, signature: `sha256=${sig.toUpperCase()}` })).toEqual({ ok: true });
  });
  it('过期：时间差超过 timeWindowSec（两个方向）；窗口边界内通过', () => {
    for (const d of [301, -301]) {
      const ts = String(NOW / 1000 + d);
      expect(verifyPostbackSignature({ ...base, timestamp: ts, signature: signPostback(SECRET, ts, BODY) })).toEqual({ ok: false, reason: 'stale' });
    }
    const ts = String(NOW / 1000 - 300);
    expect(verifyPostbackSignature({ ...base, timestamp: ts, signature: signPostback(SECRET, ts, BODY) })).toEqual({ ok: true });
  });
  it('篡改：正文 / 时间戳 / 密钥任一不同 → bad_signature', () => {
    const sig = signPostback(SECRET, TS, BODY);
    expect(verifyPostbackSignature({ ...base, rawBody: BODY.replace('register', 'deposit'), signature: sig })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPostbackSignature({ ...base, timestamp: String(NOW / 1000 - 1), signature: sig })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPostbackSignature({ ...base, signature: signPostback('t'.repeat(40), TS, BODY) })).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('缺失 / 畸形头 → malformed', () => {
    for (const [timestamp, signature] of [[TS, null], [null, 'a'.repeat(64)], ['12x', 'a'.repeat(64)], [TS, 'zz']] as const)
      expect(verifyPostbackSignature({ ...base, timestamp, signature })).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe.skipIf(!url)('loadPostbackIntegration（bydp_app）', () => {
  it('无对接 / 停用 → no_integration；引用名越界 → secret_ref_invalid；密钥引用在环境中缺失或过短 → secret_missing；正常返回密钥与窗口', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "operator_integration" ("id","brandId","postbackSecretRef","timeWindowSec") values ('oi_j','br_jinlong','POSTBACK_SECRET_JINLONG',120)`);
      await tx.execute(sql`insert into "operator_integration" ("id","brandId","postbackSecretRef","status") values ('oi_r','br_royal','POSTBACK_SECRET_ROYAL','disabled')`);
      await tx.execute(sql`insert into "operator_integration" ("id","brandId","postbackSecretRef") values ('oi_w','br_winner','BINDING_HMAC_KEY')`);
      await asApp(tx);
      return [
        await loadPostbackIntegration(tx, 'br_starlight', {}),
        await loadPostbackIntegration(tx, 'br_winner', { BINDING_HMAC_KEY: SECRET }),
        await loadPostbackIntegration(tx, 'br_royal', { POSTBACK_SECRET_ROYAL: SECRET }),
        await loadPostbackIntegration(tx, 'br_jinlong', {}),
        await loadPostbackIntegration(tx, 'br_jinlong', { POSTBACK_SECRET_JINLONG: 'short' }),
        await loadPostbackIntegration(tx, 'br_jinlong', { POSTBACK_SECRET_JINLONG: SECRET }),
      ];
    });
    expect(r).toEqual([
      { ok: false, reason: 'no_integration' },
      { ok: false, reason: 'secret_ref_invalid' }, // 自检 I2：引用名不得指向 POSTBACK_SECRET_ 以外的环境变量
      { ok: false, reason: 'no_integration' },
      { ok: false, reason: 'secret_missing' },
      { ok: false, reason: 'secret_missing' },
      { ok: true, secret: SECRET, windowSec: 120 },
    ]);
  });
});
