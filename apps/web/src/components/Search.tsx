import { Icon } from './Icon';

/** 查验输入：GET /check?q= → 服务端重定向到 /check/{identifier}（无 JS 可用） */
export function SearchForm({ action, defaultValue }: { action: string; defaultValue?: string }) {
  return (
    <form action={action} method="get" role="search">
      <label htmlFor="q" className="sr">
        粘贴任意线索
      </label>
      <input id="q" name="q" required maxLength={256} placeholder="网址 · App · TG 号 · 收款地址" defaultValue={defaultValue} autoComplete="off" />
      <button className="btn" type="submit" aria-label="查验">
        <Icon n="arrow" s={18} w={3} />
      </button>
    </form>
  );
}
