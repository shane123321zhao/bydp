'use server';
/**
 * 隐私与数据（§16 · 契约 POST /me/data-requests 同一用例）。M2：提交落库 + 站内确认通知；处理属 M3 后台。
 * 注销（匿名化）的二次验证在 core 统一校验（D-014，与 Bearer 接口共用）：会话 authTime 须在 10 分钟内。
 */
import { createDataRequest, ReauthRequiredError, type DataRequestKind } from '@bydp/core/identity/privacy';
import { MeInputError } from '@bydp/core/identity/me';
import { auth } from '../../../../auth';
import { db } from '../../../../lib/db';

const KINDS: DataRequestKind[] = ['redact_evidence', 'delete_evidence', 'export', 'anonymize'];

export type RequestResult = { ok: true; created: boolean; id: string } | { ok: false; error: string; reauth?: boolean };

export async function submitDataRequestAction(kind: string, note: string): Promise<RequestResult> {
  const session = (await auth()) as { user?: { id?: string }; authTime?: number } | null;
  const uid = session?.user?.id;
  if (!uid) return { ok: false, error: '登录已失效，请重新登录', reauth: true };
  if (!KINDS.includes(kind as DataRequestKind)) return { ok: false, error: '请求类型不识别' };
  try {
    const r = await createDataRequest(db(), uid, { kind: kind as DataRequestKind, note: note.trim() || null }, { authTime: session?.authTime });
    return { ok: true, created: r.created, id: r.id };
  } catch (e) {
    if (e instanceof ReauthRequiredError) return { ok: false, error: e.message, reauth: true };
    if (e instanceof MeInputError) return { ok: false, error: e.message };
    throw e;
  }
}
