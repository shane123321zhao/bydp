/**
 * 读取 scoring 输出的结构化指标（A-003 C3）——不再从 factors[].detail 文本解析数字。
 * 对外契约的 ScoreSnapshot.factors 不含 metrics：输出前用 publicFactors 剥离。
 */
type F = { key?: string; metrics?: Record<string, number | null> } & Record<string, unknown>;

export function metric(factors: F[] | undefined, key: string, name: string): number | null {
  const v = factors?.find((f) => f.key === key)?.metrics?.[name];
  return typeof v === 'number' ? v : null;
}
export const fmtMinutes = (m: number) =>
  m < 60 ? `${Math.round(m)} 分` : m < 1440 ? `${Math.round((m / 60) * 10) / 10} 小时` : `${Math.round((m / 1440) * 10) / 10} 天`;
export const fmtRate = (r: number) => `${Math.round(r * 1000) / 10}%`;

export const withdrawalMedian = (f: F[] | undefined) => {
  const m = metric(f, 'withdrawal', 'medianMinutes');
  return m == null ? null : fmtMinutes(m);
};
export const refusalRate = (f: F[] | undefined) => {
  const r = metric(f, 'withdrawal', 'refusalRate');
  return r == null ? null : fmtRate(r);
};
export const resolveRate = (f: F[] | undefined) => {
  const r = metric(f, 'arbitration', 'resolveRate');
  return r == null ? null : fmtRate(r);
};

export function publicFactors<T extends F>(factors: T[] | undefined): Omit<T, 'metrics'>[] {
  return (factors ?? []).map(({ metrics: _m, ...rest }) => rest);
}
