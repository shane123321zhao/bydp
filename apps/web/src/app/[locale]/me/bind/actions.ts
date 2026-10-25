'use server';
/**
 * 添加绑定（§16 · 契约 POST /me/bindings 同一用例）：自报级。「经 BYDP 领码注册」来源由服务端查本人在该品牌最近领过的码，不信任前端。
 */
import { BindingConflictError } from '@bydp/core/identity/bindings';
import { createMyBinding, listBindableBrands, MeInputError } from '@bydp/core/identity/me';
import { SelfExcludedError } from '@bydp/core/identity/self-exclusion';
import { auth } from '../../../../auth';
import { db } from '../../../../lib/db';

export type BindState = { step: 'form'; error?: string } | { step: 'done'; brandName: string; masked: string };

export async function createBindingAction(_prev: BindState, form: FormData): Promise<BindState> {
  const uid = (await auth())?.user?.id;
  if (!uid) return { step: 'form', error: '登录已失效，请重新登录' };
  const brandId = String(form.get('brandId') ?? '');
  const account = String(form.get('account') ?? '').trim();
  const source = String(form.get('source') ?? 'manual');
  if (!account) return { step: 'form', error: '请填写运营商账号 ID' };
  if (account.length > 128) return { step: 'form', error: '账号 ID 过长' };
  const target = (await listBindableBrands(db(), uid)).find((b) => b.brand.id === brandId);
  if (!target) return { step: 'form', error: '请选择认证或观察库中的平台' };
  if (source === 'promo' && !target.claimed) return { step: 'form', error: '你还没有在该平台领过码，请选「已有账号手动绑定」' };
  try {
    const b = await createMyBinding(db(), uid, { brandId, operatorAccountId: account, promoCodeId: source === 'promo' ? target.claimed!.promoCodeId : null });
    return { step: 'done', brandName: target.brand.name.zhHans ?? target.brand.name.en ?? '', masked: b.operatorAccountIdMasked ?? '' };
  } catch (e) {
    if (e instanceof BindingConflictError) return { step: 'form', error: '该运营商账号已被绑定（同一账号只能被一个 BYDP 用户绑定）' };
    if (e instanceof MeInputError) return { step: 'form', error: e.message };
    if (e instanceof SelfExcludedError) return { step: 'form', error: `${e.message}，期内不可添加绑定` };
    if (e instanceof Error && e.name === 'ZodError') return { step: 'form', error: '账号 ID 格式不正确' };
    throw e;
  }
}
