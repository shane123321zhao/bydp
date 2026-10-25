'use client';
/** 补充证据（本人案件页）：文件（截图 / 对话 / 其他）或交易哈希，逐项提交；成功后刷新页面显示新哈希 */
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Icon } from '../../../../../components/Icon';
import { addEvidenceAction } from './actions';

const FILE_TYPES: [string, string][] = [
  ['screenshot', '截图'],
  ['chat_log', '客服对话'],
  ['other', '其他'],
];

export function AddEvidence({ complaintId }: { complaintId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fileType, setFileType] = useState('screenshot');
  const [file, setFile] = useState<File | null>(null);
  const [txHash, setTxHash] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  const submit = () =>
    start(async () => {
      const fd = new FormData();
      if (file) {
        fd.set('file', file);
        fd.set('fileType', fileType);
      } else fd.set('txHash', txHash);
      const r = await addEvidenceAction(complaintId, fd);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg({ ok: true, text: `已存档 · 哈希 ${r.sha256.slice(0, 4)}…${r.sha256.slice(-4)}` });
      setFile(null);
      setTxHash('');
      setOpen(false);
      router.refresh();
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', paddingTop: 'var(--s-4)' }}>
      {open ? (
        <>
          <div style={{ display: 'flex', gap: 'var(--s-3)', flexWrap: 'wrap' }} role="radiogroup" aria-label="证据类型">
            {FILE_TYPES.map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={fileType === v} className="chip xs" aria-current={fileType === v} onClick={() => setFileType(v)}>
                {l}
              </button>
            ))}
          </div>
          <input ref={ref} type="file" accept="image/*,application/pdf,text/plain" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" className="ghost" onClick={() => ref.current?.click()}>
            <Icon n="complaint" s={15} /> {file ? `${file.name.slice(0, 24)} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '选择文件（≤ 20MB）'}
          </button>
          {!file ? (
            <div className="fld">
              <label htmlFor="ev-tx">或填入金交易哈希</label>
              <input id="ev-tx" className="f num" maxLength={200} value={txHash} onChange={(e) => setTxHash(e.target.value.trim())} autoComplete="off" />
            </div>
          ) : null}
          <button type="button" className="btn" disabled={pending || (!file && !txHash)} onClick={submit}>
            {pending ? '存档中…' : '提交证据'}
          </button>
        </>
      ) : (
        <button type="button" className="ghost" onClick={() => setOpen(true)}>
          <Icon n="complaint" s={14} /> 补充证据
        </button>
      )}
      {msg ? (
        <div className="err-line" role="status" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>
          <Icon n={msg.ok ? 'shield' : 'alert'} s={13} /> {msg.text}
        </div>
      ) : null}
    </div>
  );
}
