/**
 * 设备记录与同设备多账号标记（D-015 #2 · D-001 M2 移入 M3）：只标不拦。
 * - 设备标识：web 首次访问下发随机 httpOnly cookie（bydp_did），库内只存其盲索引 HMAC(IDENTITY_HMAC_KEY, `device:<id>`)，
 *   不采集浏览器特征、不存原始 cookie 值。
 * - 登录时 upsert (fingerprint, userId)：已有则刷新 lastSeenAt，否则新建。
 * - 新出现的 (设备, 用户) 组合若使该设备关联的用户数 ≥ 2 → 写 audit_log `device_multi_account`（actorId = system），供 admin 风控台查看。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { schema, sql, type Db } from '@bydp/db';

type Exec = Pick<Db, 'execute'>;

export const DEVICE_COOKIE = 'bydp_did';
/** 设备 cookie 值形状：32 位十六进制（随机 128 bit） */
export const DEVICE_ID = /^[0-9a-f]{32}$/;

export function deviceFingerprint(deviceId: string, hmacKey: Buffer): string {
  if (!DEVICE_ID.test(deviceId)) throw new Error('设备标识格式不识别');
  if (hmacKey.length !== 32) throw new Error('IDENTITY_HMAC_KEY 须为 32 字节');
  return createHmac('sha256', hmacKey).update(`device:${deviceId}`).digest('hex');
}

export type DeviceLoginResult = { newPair: boolean; accountsOnDevice: number; flagged: boolean };

export async function recordDeviceLogin(db: Pick<Db, 'execute' | 'transaction'>, p: { userId: string; fingerprint: string }): Promise<DeviceLoginResult> {
  return db.transaction(async (tx: Exec) => {
    // 同一设备的并发登录：按指纹加事务级咨询锁，避免重复建行 / 重复标记
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`device:${p.fingerprint}`}))`);
    const touched = (await tx.execute(
      sql`update ${schema.devices} set "lastSeenAt" = now() where "fingerprint" = ${p.fingerprint} and "userId" = ${p.userId} returning "id"`,
    )) as unknown as { id: string }[];
    const newPair = touched.length === 0;
    if (newPair) {
      await tx.execute(
        sql`insert into ${schema.devices} ("id", "userId", "fingerprint") values (${`dev_${randomUUID().replaceAll('-', '')}`}, ${p.userId}, ${p.fingerprint})`,
      );
    }
    const [r] = (await tx.execute(
      sql`select count(distinct "userId")::int as "n" from ${schema.devices} where "fingerprint" = ${p.fingerprint} and "userId" is not null`,
    )) as unknown as { n: number }[];
    const accountsOnDevice = r?.n ?? 0;
    const flagged = newPair && accountsOnDevice >= 2;
    if (flagged) {
      await tx.execute(
        sql`insert into ${schema.auditLogs} ("actorId", "actorRole", "action", "targetType", "targetId", "after")
            values ('system', null, 'device_multi_account', 'device', ${p.fingerprint.slice(0, 16)},
                    ${JSON.stringify({ userId: p.userId, accountsOnDevice })}::jsonb)`,
      );
    }
    return { newPair, accountsOnDevice, flagged };
  });
}

/** §9.2 v1.11 / 审核 A-015 Q2：已注销用户的设备行保留用于风控，注销满 180 天后删除（worker 每日任务；dryRun 只计数） */
export const DEVICE_RETENTION_AFTER_ANONYMIZE_DAYS = 180;

export async function purgeAnonymizedDevices(db: Pick<Db, 'execute'>, opts: { dryRun?: boolean; retentionDays?: number } = {}): Promise<number> {
  const days = opts.retentionDays ?? DEVICE_RETENTION_AFTER_ANONYMIZE_DAYS;
  const where = sql`"userId" in (select "id" from ${schema.users} where "anonymizedAt" < now() - make_interval(days => ${days}))`;
  if (opts.dryRun) {
    const [r] = (await db.execute(sql`select count(*)::int as "n" from ${schema.devices} where ${where}`)) as unknown as { n: number }[];
    return r?.n ?? 0;
  }
  const rows = (await db.execute(sql`delete from ${schema.devices} where ${where} returning 1`)) as unknown as unknown[];
  return rows.length;
}
