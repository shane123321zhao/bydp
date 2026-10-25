/**
 * D-029（architecture §8.1）：按当前参数表版本全量重算优惠 trueValue。参数变更升版本后、或修正历史数据（of_002 +22 → +33）时运行。
 * - 只改结果与当前公式不一致的行；每改一行写一条 audit（before / after，执行身份由调用方给出，如 system:tv-recompute）。
 * - 类型不支持 / 条款不完整的优惠不动，列入 skipped（附原因），由人工补条款后再算。
 */
import { schema, sql, type Db } from '@bydp/db';
import { writeAudit, type Actor } from '../admin/rbac';
import { computeTrueValue, TrueValueError, TV_METHOD_VERSION } from './true-value';

type Exec = Pick<Db, 'execute'>;

export async function recomputeTrueValues(db: Exec, actor: Actor, opts: { write: boolean }) {
  const rows = (await db.execute(
    sql`select "id", "type", "matchPercent", "maxBonusUsdt"::float as "maxBonusUsdt", "minDepositUsdt"::float as "minDepositUsdt", "terms", "trueValue" from ${schema.offers} order by "id"`,
  )) as unknown as { id: string; type: string; matchPercent: number | null; maxBonusUsdt: number | null; minDepositUsdt: number | null; terms: never; trueValue: Record<string, unknown> }[];
  const out = { version: TV_METHOD_VERSION, total: rows.length, changed: [] as { id: string; from: unknown; to: number }[], unchanged: 0, skipped: [] as { id: string; reason: string }[] };
  for (const r of rows) {
    let tv;
    try {
      tv = computeTrueValue(r);
    } catch (e) {
      if (!(e instanceof TrueValueError)) throw e;
      out.skipped.push({ id: r.id, reason: e.message });
      continue;
    }
    if (JSON.stringify(tv) === JSON.stringify(Object.fromEntries(Object.keys(tv).map((k) => [k, r.trueValue?.[k]])))) {
      out.unchanged++;
      continue;
    }
    out.changed.push({ id: r.id, from: r.trueValue?.netExpectedValueUsdt, to: tv.netExpectedValueUsdt });
    if (!opts.write) continue;
    await db.execute(sql`update ${schema.offers} set "trueValue" = ${JSON.stringify(tv)}::jsonb, "updatedAt" = now() where "id" = ${r.id}`);
    await writeAudit(db, actor, 'offer_true_value_recompute', { type: 'offer', id: r.id }, r.trueValue, tv);
  }
  return out;
}
