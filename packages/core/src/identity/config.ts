/** GET /config/points、/config/official-channels（可配置，读库；空表返回空结构，不硬编码） */
import { schema, sql, type Db } from '@bydp/db';

type Reader = Pick<Db, 'execute'>;
const q = <T>(db: Reader, query: ReturnType<typeof sql>) => db.execute(query) as unknown as Promise<T[]>;

export async function getPointsConfig(db: Reader): Promise<Record<string, number>> {
  const rows = await q<{ event: string; points: number }>(db, sql`select "event", "points" from ${schema.pointsRules} where "active" order by "event"`);
  return Object.fromEntries(rows.map((r) => [r.event, r.points]));
}

export async function getOfficialChannels(db: Reader) {
  const rows = await q<{ type: 'domain' | 'telegram' | 'bot'; value: string }>(
    db,
    sql`select "type", "value" from ${schema.officialChannels} where "active" order by "type", "value"`,
  );
  const pick = (t: string) => rows.filter((r) => r.type === t).map((r) => r.value);
  return { domains: pick('domain'), telegram: pick('telegram'), bots: pick('bot') };
}
