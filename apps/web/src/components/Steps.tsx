/** 05 投诉五段步骤条（原型 complaint 页）：提交 · 初筛 · 受理 · 答辩 · 结果。field-mapping 05「公用：步骤条当前节点」 */
const LABELS = ['提交', '初筛', '受理', '答辩', '结果'] as const;

/** 状态 → 当前节点（0–4）；驳回 / 曝光在「结果」节点标红 */
export function stepOf(status: string | undefined): { cur: number; red: boolean } {
  switch (status) {
    case 'screening':
      return { cur: 1, red: false };
    case 'accepted':
      return { cur: 2, red: false };
    case 'awaiting_reply':
    case 'arbitrating':
      return { cur: 3, red: false };
    case 'resolved':
      return { cur: 4, red: false };
    case 'rejected':
    case 'unresolved':
    case 'exposed':
      return { cur: 4, red: true };
    default:
      return { cur: 0, red: false };
  }
}

export function Steps({ cur, red = false, done = false }: { cur: number; red?: boolean; done?: boolean }) {
  return (
    <div className="steps" role="list" aria-label="投诉进度">
      {LABELS.map((l, i) => (
        <div key={l} className="st" role="listitem" aria-current={i === cur ? 'step' : undefined} data-s={i < cur || (done && i === cur) ? 'done' : i === cur ? (red ? 'red' : 'now') : 'todo'}>
          <span className="dot" />
          <span>{l}</span>
        </div>
      ))}
    </div>
  );
}
