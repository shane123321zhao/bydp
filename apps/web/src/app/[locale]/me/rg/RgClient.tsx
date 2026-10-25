'use client';
/**
 * 负责任博彩（原型 rg 页 · design-system §16）：自我排除五档（选中出红色警示 + redSolid 确认）；限额提醒三行（开关 + 修改）；求助卡。
 * 开启提醒时的初始值取原型示例（每日入金 500 USDT、连续在线 2 小时），用户可改；深夜时段固定 00:00–06:00。
 */
import type { Preferences } from '@bydp/core/identity/privacy';
import type { SelfExclusionState } from '@bydp/core/identity/self-exclusion';
import { useState, useTransition } from 'react';
import { Icon } from '../../../../components/Icon';
import { savePreferencesAction, startExclusionAction } from './actions';

const OPTIONS: [string, string][] = [
  ['30', '30 天'],
  ['90', '90 天'],
  ['180', '180 天'],
  ['365', '1 年'],
  ['permanent', '永久'],
];
const DEFAULT_DEPOSIT = 500;
const DEFAULT_SESSION = 120;
const HOTLINES = ['马来西亚 · 15999', '新加坡 · 1800-6-668-668', '台湾 · 1995'];

const ymd = (iso: string) => iso.slice(0, 10);
const duration = (m: number) => (m % 60 === 0 ? `${m / 60} 小时` : `${m} 分钟`);

export function RgClient({ exclusion: initialEx, prefs: initialPrefs }: { exclusion: SelfExclusionState | null; prefs: Preferences }) {
  const [ex, setEx] = useState(initialEx);
  const [pick, setPick] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(initialPrefs);
  const [editing, setEditing] = useState<'deposit' | 'session' | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const permanent = ex?.endsAt === null;

  const confirmExclusion = () =>
    pick &&
    start(async () => {
      const r = await startExclusionAction(pick);
      if (!r.ok) return setMsg({ tone: 'red', text: r.error });
      setEx(r.state);
      setPick(null);
      setMsg({ tone: 'green', text: r.state.endsAt ? `已自我排除，至 ${ymd(r.state.endsAt)}` : '已永久自我排除' });
    });

  const save = (next: Preferences) =>
    start(async () => {
      const r = await savePreferencesAction(next);
      if (!r.ok) return setMsg({ tone: 'red', text: r.error });
      setPrefs(r.prefs);
      setEditing(null);
      setMsg({ tone: 'green', text: '提醒设置已保存' });
    });

  const rows = [
    {
      key: 'deposit' as const,
      label: '每日入金提醒',
      on: prefs.dailyDepositAlertUsdt != null,
      value: `${(prefs.dailyDepositAlertUsdt ?? DEFAULT_DEPOSIT).toLocaleString('en-US')} USDT`,
      unit: 'USDT',
      current: prefs.dailyDepositAlertUsdt ?? DEFAULT_DEPOSIT,
      toggle: () => save({ ...prefs, dailyDepositAlertUsdt: prefs.dailyDepositAlertUsdt == null ? DEFAULT_DEPOSIT : null }),
      commit: (n: number) => save({ ...prefs, dailyDepositAlertUsdt: n }),
    },
    {
      key: 'session' as const,
      label: '连续在线提醒',
      on: prefs.sessionAlertMinutes != null,
      value: duration(prefs.sessionAlertMinutes ?? DEFAULT_SESSION),
      unit: '分钟',
      current: prefs.sessionAlertMinutes ?? DEFAULT_SESSION,
      toggle: () => save({ ...prefs, sessionAlertMinutes: prefs.sessionAlertMinutes == null ? DEFAULT_SESSION : null }),
      commit: (n: number) => save({ ...prefs, sessionAlertMinutes: n }),
    },
  ];

  return (
    <>
      <section className="card glass first rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
        <div className="head" style={{ paddingBottom: 0 }}>
          <h2 className="title" style={{ margin: 0 }}>
            自我排除<small>立即生效 · 期内不可撤销</small>
          </h2>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--body)' }}>
          排除期内：隐藏全部优惠与领码入口、不推送任何优惠、名单页不显示「前往官网」。查验、投诉与案件查看不受影响。
        </div>
        {ex ? (
          <div className="se-warn" role="status">
            <span style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }}>
              <Icon n="shield" s={13} />
            </span>
            <span>
              {permanent ? (
                <b>已永久自我排除</b>
              ) : (
                <>
                  <b>自我排除中</b>，至 <b className="num">{ymd(ex.endsAt!)}</b>。到期后需手动恢复，不会自动恢复；可再选更长的时长。
                </>
              )}
            </span>
          </div>
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 'var(--s-3)' }} role="radiogroup" aria-label="排除时长">
          {OPTIONS.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={pick === v} className="ghost se-opt" disabled={permanent || pending} onClick={() => setPick(v)}>
              <b className="num" style={{ fontSize: 13 }}>
                {label}
              </b>
            </button>
          ))}
        </div>
        {pick ? (
          <>
            <div className="se-warn">
              <span style={{ color: 'var(--red)', flexShrink: 0, marginTop: 2 }}>
                <Icon n="alert" s={13} />
              </span>
              <span>{pick === 'permanent' ? '永久排除不可撤销，且无法再次注册。' : '排除期内无法提前解除；到期后需手动恢复，不会自动恢复。'}</span>
            </div>
            <button type="button" className="btn btn-danger" disabled={pending} onClick={confirmExclusion}>
              确认自我排除
            </button>
          </>
        ) : null}
      </section>

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="head">
          <h2 className="title" style={{ margin: 0 }}>
            限额提醒<small>仅提醒，不代扣</small>
          </h2>
        </div>
        {rows.map((r) => (
          <div key={r.key} style={{ borderTop: '1px solid var(--gb)', padding: 'var(--s-4) 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 'var(--s-5)', alignItems: 'center', minHeight: 44 }}>
              <span style={{ fontSize: 14 }}>
                {r.label}{' '}
                <span className="num" style={{ fontSize: 12, color: r.on ? 'var(--body)' : 'var(--muted)' }}>
                  {r.value}
                </span>
              </span>
              <button
                type="button"
                className="link num"
                style={{ fontSize: 12 }}
                disabled={pending}
                onClick={() => {
                  setEditing(editing === r.key ? null : r.key);
                  setDraft(String(r.current));
                }}
              >
                修改
              </button>
              <button type="button" role="switch" aria-checked={r.on} aria-label={r.label} className="sw" disabled={pending} onClick={r.toggle} />
            </div>
            {editing === r.key ? (
              <form
                style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--s-4)', paddingTop: 'var(--s-3)' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  r.commit(Number(draft));
                }}
              >
                <div className="fld">
                  <label htmlFor={`rg-${r.key}`}>
                    {r.label}（{r.unit}）
                  </label>
                  <input
                    id={`rg-${r.key}`}
                    className="f num"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <button className="ghost" disabled={pending || !draft}>
                  保存并开启
                </button>
              </form>
            ) : null}
          </div>
        ))}
        <div style={{ borderTop: '1px solid var(--gb)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--s-5)', alignItems: 'center', minHeight: 52 }}>
          <span style={{ fontSize: 14 }}>
            深夜时段提醒{' '}
            <span className="num" style={{ fontSize: 12, color: prefs.nightAlert ? 'var(--body)' : 'var(--muted)' }}>
              00:00–06:00
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.nightAlert}
            aria-label="深夜时段提醒"
            className="sw"
            disabled={pending}
            onClick={() => save({ ...prefs, nightAlert: !prefs.nightAlert })}
          />
        </div>
      </section>

      {msg ? (
        <div className="err-line" role="status" style={{ margin: 'var(--s-6) var(--s-10) 0', color: `var(--${msg.tone})` }}>
          <Icon n={msg.tone === 'green' ? 'shield' : 'alert'} s={13} /> {msg.text}
        </div>
      ) : null}

      <section className="card glass rise" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
        <div className="title">需要帮助？</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--body)' }}>
          如果博彩已影响你的生活或财务，请联系当地专业机构。BYDP 不提供心理咨询，但会按你的选择限制自身产品对你的触达。
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          {HOTLINES.map((x) => (
            <span key={x} className="badge b-muted num">
              {x}
            </span>
          ))}
        </div>
      </section>
    </>
  );
}
