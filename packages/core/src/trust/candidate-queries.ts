/**
 * Candidate 去刷计数（D-016 第 6 项 · §13 v1.12 ⑤ · A-017 candidate_query）：/check 查到「未收录」时记一次查询。
 * - 同一查询者同一天对同一标识只记 1 行（唯一约束）；queryCount7d = 近 7 日「查询者 × 天」数，weightedPriority = 近 7 日 distinct 查询者数。
 * - 查询者 = IP 网段（v4 /24、v6 /48）：设备 Cookie 可被随手清除，按网段计才能让「同 IP 刷量」无效；无 IP 时退回设备号。
 * - viewerHash = HMAC(HKDF(IDENTITY_HMAC_KEY, info = bydp:candidate-viewer:v1), 查询者)，不存 IP / 设备原值（审核 A-017 Q2）。
 * - 爬虫 UA 不计；名称类查询不入 Candidate（只收标识）。
 */
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { schema, sql, type Db } from '@bydp/db';

type Tx = Pick<Db, 'execute' | 'transaction'>;
export const CANDIDATE_VIEWER_INFO = 'bydp:candidate-viewer:v1';
// 爬虫 / 链接预览 / 脚本客户端不计（分享到群里会被各家预览服务器从不同网段抓取）
const BOT_UA = /bot|spider|crawl|slurp|preview|facebookexternalhit|whatsapp|line\/|telegram|slack|discord|twitter|inspectiontool|lighthouse|headless|scrapy|curl|wget|python|go-http-client|okhttp|axios|node-fetch|java\/|httpclient|libwww/i;
const COUNTED_TYPES = new Set(['domain', 'mirror', 'app', 'tg', 'wallet', 'phone']);

/** v6 地址展开为 8 组（处理 :: 与内嵌 v4）；非法返回 null */
function expandV6(addr: string): number[] | null {
  let a = addr.toLowerCase().split('%')[0]!;
  const dotted = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number);
    a = a.slice(0, -dotted[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = 8 - h.length - t.length;
  if ((tail === undefined && h.length !== 8) || fill < 0) return null;
  const nums = [...h, ...Array(tail !== undefined ? fill : 0).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

export function viewerKey(viewer: { ip: string | null; deviceId: string | null; tgUserId?: string | null }): string | null {
  // TG Bot 查询（D-017）：以 TG 用户 id 为查询者（HMAC 后存，不存原值）
  if (viewer.tgUserId) return `tg:${viewer.tgUserId}`;
  const ip = viewer.ip?.trim();
  if (ip && isIP(ip) === 4) return `ip4:${ip.split('.').slice(0, 3).join('.')}`;
  if (ip && isIP(ip) === 6) {
    const g = expandV6(ip);
    if (g) {
      // v4 映射地址按 v4 /24 计；其余取 /48（前 3 组，规范化为无前导零的十六进制）
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `ip4:${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}`;
      return `ip6:${g.slice(0, 3).map((x) => x.toString(16)).join(':')}`;
    }
  }
  return viewer.deviceId ? `dev:${viewer.deviceId}` : null;
}

export function viewerHash(key: string, identityHmacKey: Buffer): string {
  const k = Buffer.from(hkdfSync('sha256', identityHmacKey, Buffer.alloc(0), CANDIDATE_VIEWER_INFO, 32));
  return createHmac('sha256', k).update(key).digest('hex');
}

/** 记一次未收录查询；返回更新后的计数（不计时返回 null） */
export async function recordCandidateQuery(
  db: Tx,
  q: { type: string; value: string },
  viewer: { ip: string | null; deviceId: string | null; userAgent: string | null; tgUserId?: string | null },
  identityHmacKey: Buffer,
): Promise<{ candidateId: string; queryCount7d: number; weightedPriority: number } | null> {
  if (!COUNTED_TYPES.has(q.type) || !q.value) return null;
  // 网页 / API：爬虫与预览 UA 不计；TG Bot 的命令来自真人对话（Telegram 已鉴别），不看 UA
  if (!viewer.tgUserId && (!viewer.userAgent || BOT_UA.test(viewer.userAgent))) return null;
  const key = viewerKey(viewer);
  if (!key) return null;
  const hash = viewerHash(key, identityHmacKey);
  // 用查验给出的规范值（钱包地址大小写敏感，不能统一转小写）
  const value = q.value.trim().slice(0, 255);
  return db.transaction(async (tx) => {
    // 同一标识的首次查询并发建 Candidate 时串行化（candidate 表无 (type, value) 唯一约束）
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`candidate:${q.type}:${value}`}, 0))`);
    const [hit] = (await tx.execute(
      sql`select "id" from ${schema.candidates} where "identifierType" = ${q.type} and lower("value") = lower(${value}) limit 1`,
    )) as unknown as { id: string }[];
    const id = hit?.id ?? `cand_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    if (!hit) {
      await tx.execute(sql`insert into ${schema.candidates} ("id", "identifierType", "value", "firstQueried") values (${id}, ${q.type}, ${value}, current_date)`);
    }
    await tx.execute(
      sql`insert into ${schema.candidateQueries} ("id", "candidateId", "viewerHash", "day")
          values (${`cq_${randomUUID().replaceAll('-', '').slice(0, 20)}`}, ${id}, ${hash}, current_date) on conflict do nothing`,
    );
    const [c] = (await tx.execute(
      sql`update ${schema.candidates} set
            "queryCount7d" = (select count(*)::int from ${schema.candidateQueries} where "candidateId" = ${id} and "day" > current_date - 7),
            "weightedPriority" = (select count(distinct "viewerHash") from ${schema.candidateQueries} where "candidateId" = ${id} and "day" > current_date - 7),
            "updatedAt" = now()
          where "id" = ${id} returning "queryCount7d", "weightedPriority"`,
    )) as unknown as { queryCount7d: number; weightedPriority: string }[];
    return { candidateId: id, queryCount7d: c!.queryCount7d, weightedPriority: Number(c!.weightedPriority) };
  });
}

/**
 * 保留期清理 + 计数衰减（worker 每日，bydp_app）：30 天前的查询记录删除；所有有计数的 Candidate 按近 7 日记录重算，
 * 无人再查的标识计数自然归零（否则只在有新查询时才重算，旧计数会一直挂在首页热查）。只重算由查询记录驱动的计数（有过记录的 Candidate）。
 */
export async function purgeCandidateQueries(db: Pick<Db, 'execute'>, days = 30): Promise<{ deleted: number; recomputed: number }> {
  const del = (await db.execute(sql`delete from ${schema.candidateQueries} where "day" < current_date - ${days}::int returning 1`)) as unknown as unknown[];
  const upd = (await db.execute(
    sql`update ${schema.candidates} c set
          "queryCount7d" = coalesce((select count(*)::int from ${schema.candidateQueries} q where q."candidateId" = c."id" and q."day" > current_date - 7), 0),
          "weightedPriority" = coalesce((select count(distinct q."viewerHash") from ${schema.candidateQueries} q where q."candidateId" = c."id" and q."day" > current_date - 7), 0),
          "updatedAt" = now()
        -- 有查询记录（30 天保留期内）的 Candidate 都重算：7 天外的记录让计数归零；seed / 人工建的（无记录）不动
        where exists (select 1 from ${schema.candidateQueries} q where q."candidateId" = c."id")
        returning 1`,
  )) as unknown as unknown[];
  return { deleted: del.length, recomputed: upd.length };
}

/** 后台 Candidate 视图：按加权排序（编辑 / 管理员） */
export async function listCandidatesByWeight(db: Pick<Db, 'execute'>, limit = 100) {
  const rows = (await db.execute(
    sql`select "id", "identifierType", "value", "queryCount7d", "weightedPriority", "firstQueried"::text as "firstQueried", "status"
        from ${schema.candidates} where "status" = 'pending_review' order by "weightedPriority" desc, "queryCount7d" desc, "id" limit ${limit}`,
  )) as unknown as { id: string; identifierType: string; value: string; queryCount7d: number; weightedPriority: string; firstQueried: string; status: string }[];
  return rows.map((r) => ({ ...r, weightedPriority: Number(r.weightedPriority) }));
}

/** 站点监控记录保留期清理（worker，bydp_app，A-017：90 天） */
export async function purgeSiteChecks(db: Pick<Db, 'execute'>, days = 90): Promise<number> {
  const rows = (await db.execute(sql`delete from ${schema.siteChecks} where "checkedAt" < now() - make_interval(days => ${days}) returning 1`)) as unknown as unknown[];
  return rows.length;
}
