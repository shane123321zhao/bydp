'use client';
/**
 * 05 提交投诉三步（原型 complaint 页 form 态 · design-system §12–§14 · D-014）：
 * ① 选投诉对象（任何库的品牌；附本人绑定状态）→ ② 填写事实 + 证据 → ③ 确认提交 → 跳本人案件页。
 * 字段：field-mapping 05「表单」——Brand · ScoreSnapshot.score · UserBrandBinding.verificationLevel；Complaint.category / amountUsdt / eventDate / description；Evidence.type。
 */
import type { ComplainableBrand } from '@bydp/core/complaint/form';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Logo, StatusBadge, fmtUsdt, zhName } from '../../../components/atoms';
import { Icon } from '../../../components/Icon';
import { Steps } from '../../../components/Steps';
import { submitComplaintAction } from './actions';

const CATS: [string, string][] = [
  ['refused', '拒付'],
  ['delay', '提款延迟'],
  ['frozen', '冻结账号'],
  ['bonus', '优惠争议'],
  ['closed', '关站失联'],
];
const FILE_TYPES: [string, string][] = [
  ['screenshot', '截图'],
  ['chat_log', '客服对话'],
  ['other', '其他'],
];
const LEVEL: Record<string, string> = { self_reported: '已绑定（自报级）', postback_confirmed: '已绑定（回传确认）', operator_confirmed: '已绑定（运营商确认）' };
const MAX_FILE = 20 * 1024 * 1024;

export function ComplaintForm({ brands, initial, today }: { brands: ComplainableBrand[]; initial: string | null; today: string }) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(initial ? 2 : 1);
  const [brandId, setBrandId] = useState(initial ?? '');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [description, setDescription] = useState('');
  const [fileType, setFileType] = useState('screenshot');
  const [file, setFile] = useState<File | null>(null);
  const [txHash, setTxHash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const target = brands.find((b) => b.brand.id === brandId);
  const catLabel = CATS.find((c) => c[0] === category)?.[1];

  const toConfirm = () => {
    const n = Number(amount.replace(/,/g, ''));
    if (!category) return setError('请选择投诉类型');
    if (!Number.isFinite(n) || n <= 0) return setError('请填写涉及金额（USDT）');
    if (!eventDate) return setError('请填写事件日期');
    if (eventDate > today) return setError('事件日期不能晚于今天');
    if (!description.trim()) return setError('请填写经过');
    if (file && file.size > MAX_FILE) return setError('单个证据不超过 20MB');
    setError(null);
    setStep(3);
  };

  const submit = () =>
    start(async () => {
      const fd = new FormData();
      fd.set('brandId', brandId);
      fd.set('category', category);
      fd.set('amountUsdt', amount);
      fd.set('eventDate', eventDate);
      fd.set('description', description);
      if (file) {
        fd.set('file', file);
        fd.set('fileType', fileType);
      }
      if (txHash.trim()) fd.set('txHash', txHash.trim());
      const r = await submitComplaintAction(fd);
      if (!r.ok) return setError(r.error);
      router.push(`/me/complaints/${r.id}${r.warning ? `?w=${encodeURIComponent(r.warning)}` : ''}`);
    });

  const header = (
    <section className="card glass first rise">
      <Steps cur={0} />
    </section>
  );

  if (step === 1)
    return (
      <>
        {header}
        <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
          <div className="head" style={{ paddingBottom: 0 }}>
            <h2 className="title" style={{ margin: 0 }}>
              投诉对象<small>从库中选择</small>
            </h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }} role="radiogroup" aria-label="投诉对象">
            {brands.map(({ brand, binding }) => (
              <button
                key={brand.id}
                type="button"
                role="radio"
                aria-checked={brand.id === brandId}
                className="ghost pick"
                style={{ height: 60, justifyContent: 'flex-start', gap: 'var(--s-6)', padding: '0 var(--s-6)' }}
                onClick={() => {
                  setBrandId(brand.id);
                  setStep(2);
                }}
              >
                <Logo b={brand} size={36} />
                <span style={{ flexGrow: 1, textAlign: 'left', minWidth: 0 }}>
                  <b style={{ fontSize: 14 }}>{zhName(brand)}</b>
                  <span className="num" style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                    {[brand.primaryDomain, brand.score?.score != null ? `评分 ${brand.score.score}` : null, binding ? LEVEL[binding.verificationLevel] : '未绑定账号'].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <StatusBadge b={brand} />
              </button>
            ))}
          </div>
        </section>
      </>
    );

  const brandRow = target ? (
    <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr auto', gap: 'var(--s-6)', alignItems: 'center' }}>
      <Logo b={target.brand} size={44} />
      <div style={{ minWidth: 0 }}>
        <div className="s" style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center' }}>
          <b style={{ fontSize: 15 }}>{zhName(target.brand)}</b>
          <StatusBadge b={target.brand} />
        </div>
        <div className="num" style={{ fontSize: 11, color: 'var(--muted)' }}>
          {[target.brand.primaryDomain, target.brand.score?.score != null ? `评分 ${target.brand.score.score}` : null, target.binding ? LEVEL[target.binding.verificationLevel] : '未绑定账号']
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {step === 2 ? (
        <button type="button" className="chip xs" onClick={() => setStep(1)}>
          更换
        </button>
      ) : null}
    </div>
  ) : null;

  const errorLine = error ? (
    <div className="err-line" role="alert" style={{ margin: 'var(--s-6) var(--s-10) 0' }}>
      <Icon n="alert" s={13} /> {error}
    </div>
  ) : null;

  if (step === 2)
    return (
      <>
        {header}
        <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
          <div className="head" style={{ paddingBottom: 0 }}>
            <h2 className="title" style={{ margin: 0 }}>
              投诉对象<small>第 2 步 · 共 3 步</small>
            </h2>
          </div>
          {brandRow}
          {target && target.brand.status !== 'certified' ? (
            <div className="se-warn">
              <span style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }}>
                <Icon n="alert" s={13} />
              </span>
              <span>该品牌未认证，本案不适用先行赔付；投诉仍会受理、通知运营商并公开处理结果。</span>
            </div>
          ) : null}
        </section>

        <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
          <div className="head" style={{ paddingBottom: 0 }}>
            <h2 className="title" style={{ margin: 0 }}>
              事实<small>类型 · 金额 · 时间</small>
            </h2>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }} role="radiogroup" aria-label="投诉类型">
            {CATS.map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={category === v} className="chip" aria-current={category === v} onClick={() => setCategory(v)}>
                {l}
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-4)' }}>
            <div className="fld">
              <label htmlFor="cp-amount">涉及金额 USDT</label>
              <input id="cp-amount" className="f num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} />
            </div>
            <div className="fld">
              <label htmlFor="cp-date">事件日期</label>
              <input id="cp-date" className="f num" type="date" max={today} value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <label htmlFor="cp-desc" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>经过（不含个人信息）</span>
              <span className="num">{description.length} / 500</span>
            </label>
            <textarea id="cp-desc" className="f" rows={4} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </section>

        <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
          <div className="head" style={{ paddingBottom: 0 }}>
            <h2 className="title" style={{ margin: 0 }}>
              证据<small>上传即哈希存档 · 可稍后补充</small>
            </h2>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }} role="radiogroup" aria-label="证据类型">
            {FILE_TYPES.map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={fileType === v} className="chip xs" aria-current={fileType === v} onClick={() => setFileType(v)}>
                {l}
              </button>
            ))}
          </div>
          <input ref={fileRef} type="file" accept="image/*,application/pdf,text/plain" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="ghost" onClick={() => fileRef.current?.click()}>
            <Icon n="complaint" s={15} /> {file ? `${file.name.slice(0, 24)} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '选择文件（≤ 20MB）'}
          </button>
          <div className="fld">
            <label htmlFor="cp-tx">入金交易哈希（选填）</label>
            <input id="cp-tx" className="f num" maxLength={200} value={txHash} onChange={(e) => setTxHash(e.target.value.trim())} autoComplete="off" />
          </div>
          <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--muted)' }}>原文可随时申请脱敏 / 删除；哈希与状态日志永久保留（只追加）。</span>
        </section>
        {errorLine}
        <section className="rise" style={{ margin: 'var(--s-6) var(--s-10) 0' }}>
          <button type="button" className="btn" onClick={toConfirm}>
            下一步 · 确认 <Icon n="arrow" s={15} w={2.8} />
          </button>
        </section>
      </>
    );

  return (
    <>
      {header}
      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="head" style={{ paddingBottom: 0 }}>
          <h2 className="title" style={{ margin: 0 }}>
            确认提交<small>第 3 步 · 共 3 步</small>
          </h2>
        </div>
        {brandRow}
        {[
          ['类型', catLabel ?? ''],
          ['涉及金额', `${fmtUsdt(Number(amount.replace(/,/g, '')))} USDT`],
          ['事件日期', eventDate],
          ['证据', [file ? `${FILE_TYPES.find((f) => f[0] === fileType)?.[1]} 1 份` : null, txHash ? '交易哈希 1 条' : null].filter(Boolean).join(' · ') || '暂无（可稍后补充）'],
        ].map(([k, v]) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 'var(--s-5)', borderTop: '1px solid var(--gb)', paddingTop: 'var(--s-4)', fontSize: 13 }}>
            <span style={{ color: 'var(--muted)' }}>{k}</span>
            <span className="num">{v}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid var(--gb)', paddingTop: 'var(--s-4)', fontSize: 13, lineHeight: 1.6, color: 'var(--body)', whiteSpace: 'pre-wrap' }}>{description}</div>
      </section>
      {errorLine}
      <section className="rise" style={{ margin: 'var(--s-6) var(--s-10) 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <button type="button" className="btn" disabled={pending} onClick={submit}>
          {pending ? '提交中…' : '提交投诉 · 进入初筛'} <Icon n="arrow" s={15} w={2.8} />
        </button>
        <button type="button" className="ghost" disabled={pending} onClick={() => setStep(2)}>
          返回修改
        </button>
        <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--muted)' }}>提交后进入人工初筛；受理即通知运营商，答辩期 7 天；处理结果公开摘要。</span>
      </section>
    </>
  );
}
