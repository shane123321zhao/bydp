/**
 * Agent 专用数据库连接（A-017 / §13 v1.12 ①）：只用 bydp_agent 角色（只读规则所需列 + 新建 review_item / site_check）。
 * 连接池 2，低于角色的 CONNECTION LIMIT 5；语句超时 30s 由角色设置保证。未配置时拒绝启动（不回落到 bydp_app）。
 */
import { createDb, sql, type Db } from '@bydp/db';

export type AgentDb = Pick<Db, 'execute'>;

export function connectAgent(url = process.env.DATABASE_URL_AGENT) {
  if (!url) throw new Error('DATABASE_URL_AGENT 未设置：Agent 任务只能以 bydp_agent 运行');
  return createDb(url, { max: 2 });
}

/** review_item 新建（待决）；同一对象同一类已有待决提议时跳过（部分唯一索引 + on conflict do nothing） */
export async function proposeReviewItem(db: AgentDb, p: { kind: string; subject: string; proposal: unknown; source: string }): Promise<boolean> {
  const id = `ri_${crypto.randomUUID().replaceAll('-', '')}`;
  const rows = (await db.execute(
    sql`insert into "review_item" ("id", "kind", "subject", "proposal", "source")
        values (${id}, ${p.kind}, ${p.subject}, ${JSON.stringify(p.proposal)}::jsonb, ${p.source})
        on conflict do nothing returning "id"`,
  )) as unknown as unknown[];
  return rows.length > 0;
}
