/**
 * 评分快照写入（worker → core → bydp_app，ADR-0006：scoring 不持有写连接）。
 * 幂等（A-003 C5）：同一 (brandId, algorithmVersion, computedAt) 已存在则跳过——快照即历史，不可改（R2），重跑不产生重复。
 */
import { schema, sql, type Db } from '@bydp/db';

export type SnapshotWrite = {
  brandId: string;
  algorithmVersion: string;
  computedAt: Date;
  score: number | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  factorsAvailable: number;
  factorsTotal: number;
  factors: unknown[];
};

/**
 * 自检 S-a：整批在一个事务内（要么全写要么全不写，排名不会混用两天的快照）；
 * 主键由唯一键派生，ON CONFLICT DO NOTHING 保证并发重跑也不报错、不重复。
 */
export async function writeScoreSnapshots(db: Pick<Db, 'transaction'>, snaps: SnapshotWrite[]) {
  return db.transaction(async (tx) => {
  let inserted = 0;
  for (const s of snaps) {
    const rows = (await tx.execute(sql`
      insert into ${schema.scoreSnapshots} ("id", "brandId", "algorithmVersion", "computedAt", "score", "confidence", "factorsAvailable", "factorsTotal", "factors")
      select ${`ss_${s.brandId}_${s.algorithmVersion}_${s.computedAt.toISOString()}`}, ${s.brandId}, ${s.algorithmVersion}, ${s.computedAt.toISOString()}::timestamptz,
             ${s.score}, ${s.confidence}, ${s.factorsAvailable}, ${s.factorsTotal}, ${JSON.stringify(s.factors)}::jsonb
      where not exists (select 1 from ${schema.scoreSnapshots}
                        where "brandId" = ${s.brandId} and "algorithmVersion" = ${s.algorithmVersion} and "computedAt" = ${s.computedAt.toISOString()}::timestamptz)
      on conflict ("id") do nothing
      returning "id"`)) as unknown as { id: string }[];
    inserted += rows.length;
  }
  return { inserted, skipped: snaps.length - inserted };
  });
}
