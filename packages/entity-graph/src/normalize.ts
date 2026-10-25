/**
 * 标识规范化（ADR-0005：pg_trgm 之外的规范化层）。纯函数，无 DB 依赖。
 * - detect：输入 → 标识类型（domain / tg / wallet / app / phone / name）
 * - normalize：同类型下的规范形（用于精确匹配 identifier.value）
 * - skeleton：形近骨架（punycode→Unicode、NFKC、同形字、字母数字替换），骨架相同 = 形近
 */
import { domainToASCII, domainToUnicode } from 'node:url';

export type IdentifierKind = 'domain' | 'tg' | 'wallet' | 'app' | 'phone' | 'name';
export type Normalized = { type: IdentifierKind; value: string; chain?: 'TRC20' | 'ERC20' };

const TRC20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const ERC20 = /^0x[0-9a-fA-F]{40}$/;
const TG_URL = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(@?[A-Za-z0-9_]{4,64})\/?$/i;
const TG_HANDLE = /^@[A-Za-z0-9_]{4,64}$/;
const APP_ID = /^(?:com|net|org|io|app|cn|vip)\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i;
const PHONE = /^\+?[\d\s-]{7,20}$/;
const HOSTLIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^\s/?#]+\.[^\s/?#]{2,}(?:[/?#].*)?$/iu;

export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.replace(/^[^@]*@/, ''); // user@host
  s = s.replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  const ascii = domainToASCII(s);
  if (!ascii || !ascii.includes('.')) return null;
  return ascii;
}

export function detect(input: string): Normalized {
  const q = input.trim();
  if (TRC20.test(q)) return { type: 'wallet', value: q, chain: 'TRC20' };
  if (ERC20.test(q)) return { type: 'wallet', value: q.toLowerCase(), chain: 'ERC20' };
  const tg = TG_URL.exec(q);
  if (tg) return { type: 'tg', value: '@' + tg[1]!.replace(/^@/, '').toLowerCase() };
  if (TG_HANDLE.test(q)) return { type: 'tg', value: q.toLowerCase() };
  if (APP_ID.test(q) && !/[/:]/.test(q)) return { type: 'app', value: q.toLowerCase() };
  if (PHONE.test(q) && /\d{7,}/.test(q.replace(/[\s-]/g, ''))) return { type: 'phone', value: q.replace(/[\s-]/g, '') };
  if (HOSTLIKE.test(q)) {
    const d = normalizeDomain(q);
    if (d) return { type: 'domain', value: d };
  }
  return { type: 'name', value: q.normalize('NFKC').trim() };
}

/** 常见同形字（西里尔 / 希腊 → 拉丁）；按需扩充，改动需补测试 */
const CONFUSABLES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ѕ: 's', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l',
  α: 'a', ο: 'o', ρ: 'p', ν: 'v', ι: 'i', κ: 'k', τ: 't', υ: 'u', χ: 'x',
};
/** 字母数字替换：只收常见仿冒替换（0→o、1→l、3→e、5→s），不含 8 等易误伤的数字 */
const DIGIT_SWAPS: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '5': 's' };

export function skeleton(value: string): string {
  let s = value.toLowerCase();
  if (s.includes('xn--')) s = domainToUnicode(s) || s;
  s = s.normalize('NFKC');
  s = [...s].map((ch) => CONFUSABLES[ch] ?? ch).join('');
  s = s.replace(/[0135]/g, (d) => DIGIT_SWAPS[d]!);
  s = s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[-_]/g, '').replace(/i/g, 'l');
  return s;
}

/** 形近但不相同：两个值规范形不同、骨架相同 */
export function isLookalike(a: string, b: string): boolean {
  return a !== b && skeleton(a) === skeleton(b);
}
