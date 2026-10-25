'use server';
/**
 * 负责任博彩（§16 · 契约 /me/self-exclusion、/me/preferences 同一用例）。userId 只取自会话。
 * 自我排除立即生效、期内不可撤销；限额提醒仅提醒不代扣（null = 关闭）。
 */
import { Preferences } from '@bydp/core/identity';
import { putPreferences, type Preferences as Prefs } from '@bydp/core/identity/privacy';
import { SELF_EXCLUSION_PERIODS, startSelfExclusion, type SelfExclusionPeriod, type SelfExclusionState } from '@bydp/core/identity/self-exclusion';
import { auth } from '../../../../auth';
import { db } from '../../../../lib/db';

export type ExclusionResult = { ok: true; state: SelfExclusionState } | { ok: false; error: string };

export async function startExclusionAction(period: string): Promise<ExclusionResult> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { ok: false, error: '登录已失效，请重新登录' };
  if (!SELF_EXCLUSION_PERIODS.includes(period as SelfExclusionPeriod)) return { ok: false, error: '请选择排除时长' };
  return { ok: true, state: await startSelfExclusion(db(), uid, period as SelfExclusionPeriod) };
}

export type PrefsResult = { ok: true; prefs: Prefs } | { ok: false; error: string };

export async function savePreferencesAction(input: Prefs): Promise<PrefsResult> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { ok: false, error: '登录已失效，请重新登录' };
  const p = Preferences.safeParse(input);
  if (!p.success) return { ok: false, error: '数值超出范围：每日入金 10–100,000 USDT，连续在线 30–720 分钟' };
  return { ok: true, prefs: await putPreferences(db(), uid, p.data) };
}
