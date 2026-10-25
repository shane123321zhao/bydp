/**
 * 反滥用（D-015 #2）：投诉 / 证据按用户限流、证据类型白名单（#21）、下载响应头、同设备多账号标记（只标不拦）。
 * 限流计数用进程内计数器（与 Redis 版同接口）；DB 用例在已迁移 + seed 的库上事务内执行后回滚，以 bydp_app 执行。
 */
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { ABUSE_LIMITS, RateLimitedError, assertEvidenceQuota, countEvidence } from '../src/abuse/limits';
import { evidenceDownloadHeaders, sniffEvidenceType } from '../src/complaint/evidence-type';
import { ComplaintInputError, addEvidence, submitComplaint } from '../src/complaint/write';
import { MemoryRateCounter } from '../src/identity/auth';
import { deviceFingerprint, recordDeviceLogin } from '../src/identity/device';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local role bydp_app`);
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
const COMPLAINT = { brandId: 'br_winner', category: 'delay' as const, amountUsdt: 100, eventDate: '2026-09-20', description: 'x' };
const store = { put: async () => {} };

describe('证据类型白名单（#21，按文件头判定）', () => {
  it('图片 / PDF / 纯文本识别；可执行文件与二进制 → null', () => {
    expect([PNG, JPEG, PDF, WEBP].map(sniffEvidenceType)).toEqual(['image/png', 'image/jpeg', 'application/pdf', 'image/webp']);
    expect(sniffEvidenceType(new TextEncoder().encode('客服说审核中\n第二行'))).toBe('text/plain');
    expect(sniffEvidenceType(EXE)).toBeNull();
    expect(sniffEvidenceType(new Uint8Array([0xc3, 0x28]))).toBeNull(); // 非法 UTF-8
  });
  it('下载头：一律 attachment + nosniff + 沙箱 CSP；文件名只用证据 id；未知类型 → octet-stream', () => {
    expect(evidenceDownloadHeaders('ev_abc123', PNG)).toMatchObject({
      'Content-Type': 'image/png',
      'Content-Disposition': 'attachment; filename="ev_abc123.png"',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    expect(evidenceDownloadHeaders('ev_x"/../a', EXE)).toMatchObject({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="ev_xa.bin"' });
    expect(evidenceDownloadHeaders('ev_t', new TextEncoder().encode('<script>alert(1)</script>'))['Content-Type']).toBe('text/plain; charset=utf-8');
  });
});

describe('证据按用户限流（计数器）', () => {
  it('份数到上限 → RateLimitedError；累计字节超 200MB → RateLimitedError；窗口过后恢复', async () => {
    let now = 0;
    const c = new MemoryRateCounter(() => now);
    for (let i = 0; i < ABUSE_LIMITS.evidenceFilesPerUserDay; i++) await countEvidence(c, 'u_x', 1024);
    await expect(assertEvidenceQuota(c, 'u_x', 1)).rejects.toBeInstanceOf(RateLimitedError);
    const c2 = new MemoryRateCounter(() => now);
    await countEvidence(c2, 'u_y', ABUSE_LIMITS.evidenceBytesPerUserDay - 10);
    await expect(assertEvidenceQuota(c2, 'u_y', 10)).resolves.toBeUndefined();
    await expect(assertEvidenceQuota(c2, 'u_y', 11)).rejects.toBeInstanceOf(RateLimitedError);
    now += 86_400_000;
    await expect(assertEvidenceQuota(c, 'u_x', 1)).resolves.toBeUndefined();
  });
});

describe.skipIf(!url)('投诉 / 证据限流与白名单（DB）', () => {
  it('每用户 24 小时第 4 件投诉 → RateLimitedError；失败的提交不占额度；他人不受影响', async () => {
    const r = await inTx(async (tx) => {
      const c = new MemoryRateCounter();
      const bad = await submitComplaint(tx, 'u_233', { ...COMPLAINT, brandId: 'br_nope' }, { counter: c }).catch((e) => e);
      for (let i = 0; i < ABUSE_LIMITS.complaintsPerUserDay; i++) await submitComplaint(tx, 'u_233', COMPLAINT, { counter: c });
      const fourth = await submitComplaint(tx, 'u_233', COMPLAINT, { counter: c }).catch((e) => e);
      const other = await submitComplaint(tx, 'u_509', COMPLAINT, { counter: c });
      return { bad, fourth, other };
    });
    expect(r.bad).toBeInstanceOf(ComplaintInputError);
    expect(r.fourth).toBeInstanceOf(RateLimitedError);
    expect(r.other.id).toBeTruthy();
  });

  it('证据：可执行文件被拒（白名单）且不计数；PNG 通过并按判定类型写入存储', async () => {
    const puts: (string | null)[] = [];
    const r = await inTx(async (tx) => {
      const c = new MemoryRateCounter();
      const cp = await submitComplaint(tx, 'u_233', COMPLAINT);
      const exe = await addEvidence(tx, store, 'u_233', cp.id, { type: 'other', content: EXE, contentType: 'image/png' }, { counter: c }).catch((e) => e);
      const counted = await c.peek('ev:n:u_233');
      await addEvidence(tx, { put: async (_k, _b, t) => void puts.push(t) }, 'u_233', cp.id, { type: 'screenshot', content: PNG, contentType: 'text/html' }, { counter: c });
      return { exe, counted, after: await c.peek('ev:n:u_233'), bytes: await c.peek('ev:b:u_233') };
    });
    expect(r.exe).toBeInstanceOf(ComplaintInputError);
    expect(r.counted).toBe(0);
    expect(puts).toEqual(['image/png']);
    expect([r.after, r.bytes]).toEqual([1, PNG.byteLength]);
  });
});

describe.skipIf(!url)('同设备多账号标记（只标不拦）', () => {
  const key = Buffer.alloc(32, 9);
  const fp = deviceFingerprint('0123456789abcdef0123456789abcdef', key);
  it('同一设备：首个账号不标；第二个账号首次登录 → audit_log device_multi_account；重复登录不重复标记', async () => {
    const r = await inTx(async (tx) => {
      const a1 = await recordDeviceLogin(tx, { userId: 'u_102', fingerprint: fp });
      const a2 = await recordDeviceLogin(tx, { userId: 'u_102', fingerprint: fp });
      const b1 = await recordDeviceLogin(tx, { userId: 'u_233', fingerprint: fp });
      const b2 = await recordDeviceLogin(tx, { userId: 'u_233', fingerprint: fp });
      const logs = (await tx.execute(
        sql`select "actorId", "action", "targetId", "after"->>'userId' as "u", ("after"->>'accountsOnDevice')::int as "n" from "audit_log" where "action" = 'device_multi_account' and "targetId" = ${fp.slice(0, 16)}`,
      )) as unknown as Record<string, unknown>[];
      const rows = (await tx.execute(sql`select count(*)::int as n from "device" where "fingerprint" = ${fp}`)) as unknown as { n: number }[];
      return { a1, a2, b1, b2, logs, rows: rows[0]!.n };
    });
    expect(r.a1).toEqual({ newPair: true, accountsOnDevice: 1, flagged: false });
    expect(r.a2).toEqual({ newPair: false, accountsOnDevice: 1, flagged: false });
    expect(r.b1).toEqual({ newPair: true, accountsOnDevice: 2, flagged: true });
    expect(r.b2.flagged).toBe(false);
    expect(r.logs).toEqual([{ actorId: 'system', action: 'device_multi_account', targetId: fp.slice(0, 16), u: 'u_233', n: 2 }]);
    expect(r.rows).toBe(2);
  });
  it('设备标识形状与密钥长度校验；同一标识 → 同一指纹，不存原值', () => {
    expect(() => deviceFingerprint('not-a-device-id', key)).toThrow();
    expect(() => deviceFingerprint('0123456789abcdef0123456789abcdef', Buffer.alloc(8))).toThrow();
    expect(deviceFingerprint('0123456789abcdef0123456789abcdef', key)).toBe(fp);
    expect(fp).not.toContain('0123456789abcdef');
  });
});
