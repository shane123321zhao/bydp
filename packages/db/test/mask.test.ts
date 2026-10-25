/** 掩码口径（上线前置 #18 定稿 · A-012）：露出位数 = min(5, ⌊长度/3⌋)，前段 ≤ 3（取一半向上取整），中间 * 补齐原长度；< 3 位全遮 */
import { describe, expect, it } from 'vitest';
import { maskOperatorAccount } from '../src/binding-crypto';

describe('maskOperatorAccount（#18）', () => {
  it.each([
    ['ab', '***'],
    ['abc', 'a**'],
    ['RA-778', 'R****8'],
    ['abcdefghijyz', 'ab********yz'],
    ['abcdefghijklmyz', 'abc**********yz'],
    ['abcdefghijklmnopqrstuvwxyz', 'abc*********************yz'],
  ])('%s → %s', (input, out) => {
    expect(maskOperatorAccount(input)).toBe(out);
  });
  it('露出位数永不超过长度的 1/3，且不超过 5', () => {
    for (let n = 0; n <= 64; n++) {
      const m = maskOperatorAccount('x'.repeat(n).replace(/x/g, (_, i: number) => String.fromCharCode(97 + (i % 26))));
      const shown = [...m].filter((c) => c !== '*').length;
      expect(shown).toBeLessThanOrEqual(Math.min(5, Math.floor(n / 3)));
    }
  });
});
