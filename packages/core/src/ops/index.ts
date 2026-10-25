/**
 * 运维守卫（D-020 #4 · HANDOVER §9 #7 / #15）。
 * - assertDbUtc：服务启动时断言数据库会话时区为 UTC（日期类字段 current_date / statusSince 依赖之），不符即拒绝启动。
 * - createAlerter：alert 级事件 → 结构化日志 + Telegram 推送给全部持 admin 角色、绑定了 TG 的账号（复用 @BYDP_001_bot 与已存联系方式，
 *   不新增密钥）；同一事件 10 分钟内只推一次；推送失败不影响业务。文案只含事件名与简短说明，不含用户数据——
 *   异常须先经 errorSummary 只取类名与数据库错误码（drizzle 的 message 会带 SQL 参数，自检 I6），不得把 e.message 直接当说明。
 * - diskAvailableGb：容器内 statfs('/') 即宿主根分区可用空间（overlay 落在宿主根分区）；低于 25GB 告警（测试站曾降至 18GB）。
 */
import { statfs } from 'node:fs/promises';
import { schema, sql, type Db } from '@bydp/db';
import { getNotifyTarget, type AuthKeys } from '../identity/auth';
import type { SendTelegram } from '../notify/deliver';

type Exec = Pick<Db, 'execute'>;
export const DISK_ALERT_GB = 25;
const ALERT_INTERVAL_MS = 10 * 60_000;

export class DbTimezoneError extends Error {
  constructor(tz: string) {
    super(`数据库会话时区为 ${tz}，须为 UTC（HANDOVER §9 #7）`);
    this.name = 'DbTimezoneError';
  }
}

export async function assertDbUtc(db: Exec): Promise<void> {
  const [r] = (await db.execute(sql`select current_setting('TimeZone') as "tz"`)) as unknown as { tz: string }[];
  const tz = r?.tz ?? '';
  if (!/^(UTC|Etc\/UTC|GMT|Etc\/GMT|UCT|Zulu)$/i.test(tz)) throw new DbTimezoneError(tz);
}

export async function diskAvailableGb(path = '/'): Promise<number> {
  const s = await statfs(path);
  return Math.floor((s.bavail * s.bsize) / 1024 ** 3);
}

export type Alert = (evt: string, detail: string) => Promise<void>;

/** 异常 → 可推送的摘要：类名 + Postgres 错误码（不含 message：其中可能有 SQL 参数 / 用户数据） */
export function errorSummary(e: unknown): string {
  const name = (e as Error)?.name ?? 'Error';
  let code: string | undefined;
  for (let x: unknown = e, i = 0; x && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const c = (x as { code?: unknown }).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) code = c;
  }
  return code ? `${name}（数据库错误码 ${code}）` : name;
}

export function createAlerter(deps: { db: Exec; keys: () => AuthKeys; send: () => SendTelegram | null; env?: string; now?: () => number }): Alert {
  const last = new Map<string, number>();
  const now = deps.now ?? Date.now;
  return async (evt, detail) => {
    console.error(JSON.stringify({ evt, level: 'alert', detail: detail.slice(0, 300) }));
    const t = now();
    if ((last.get(evt) ?? -Infinity) > t - ALERT_INTERVAL_MS) return;
    last.set(evt, t);
    try {
      const send = deps.send();
      if (!send) return;
      const admins = (await deps.db.execute(
        sql`select distinct "userId" from ${schema.userRoles} where "roleKey" = 'admin' order by "userId"`,
      )) as unknown as { userId: string }[];
      const text = `⚠️ BYDP ${deps.env ?? ''} 告警\n${evt}\n${detail.slice(0, 300)}`.replace(/  +/g, ' ');
      for (const a of admins) {
        const target = await getNotifyTarget(deps.db, a.userId, deps.keys());
        if (target?.provider === 'telegram') await send(target.contact, text).catch(() => 'blocked');
      }
    } catch (e) {
      console.error(JSON.stringify({ evt: 'alert_push_failed', error: (e as Error).message.slice(0, 120) }));
    }
  };
}

/** 未配置 TG Bot 时只记日志的告警（本地 / 测试） */
export const logOnlyAlert: Alert = async (evt, detail) => {
  console.error(JSON.stringify({ evt, level: 'alert', detail: detail.slice(0, 300) }));
};

