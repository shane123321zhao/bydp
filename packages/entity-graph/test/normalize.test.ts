import { describe, expect, it } from 'vitest';
import { decideVerdict, detect, isLookalike, normalizeDomain, skeleton, VERDICT_TEXT } from '../src/index';

describe('detect / normalize', () => {
  it.each([
    ['cs-poker.net', { type: 'domain', value: 'cs-poker.net' }],
    ['https://WWW.JinLong88.com/login?x=1', { type: 'domain', value: 'jinlong88.com' }],
    ['jinlong88.com.', { type: 'domain', value: 'jinlong88.com' }],
    ['http://jinlong88.com:8080/', { type: 'domain', value: 'jinlong88.com' }],
    ['@JinLong_Official', { type: 'tg', value: '@jinlong_official' }],
    ['https://t.me/jinlong_official', { type: 'tg', value: '@jinlong_official' }],
    ['TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', { type: 'wallet', value: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', chain: 'TRC20' }],
    ['com.crownpacific.app', { type: 'app', value: 'com.crownpacific.app' }],
    ['金龙娱乐城', { type: 'name', value: '金龙娱乐城' }],
    ['+60 12-345 6789', { type: 'phone', value: '+60123456789' }],
  ])('%s', (q, want) => expect(detect(q)).toEqual(want));

  it('IDN 域名转 punycode', () => {
    expect(normalizeDomain('金龙88.com')).toMatch(/^xn--/);
  });
});

describe('skeleton / 形近', () => {
  it('字母数字替换：jin1ong88 ≈ jinlong88', () => expect(isLookalike('jin1ong88.com', 'jinlong88.com')).toBe(true));
  it('西里尔同形字 ≈ 拉丁', () => expect(isLookalike('jіnlong88.com', 'jinlong88.com')).toBe(true));
  it('punycode 形式也能还原比对', () => expect(skeleton(normalizeDomain('jіnlong88.com')!)).toBe(skeleton('jinlong88.com')));
  it('rn → m', () => expect(isLookalike('jinlorng88.com', 'jinlomg88.com')).toBe(true));
  it('连字符忽略', () => expect(isLookalike('cs-poker.net', 'cspoker.net')).toBe(true));
  it('相同值不算形近', () => expect(isLookalike('jinlong88.com', 'jinlong88.com')).toBe(false));
  it('无关域名不形近', () => expect(isLookalike('winner-sport.co', 'jinlong88.com')).toBe(false));
  it('数字 8 不参与替换（避免 88 误伤）', () => expect(skeleton('jinlong88.com')).toContain('88'));
});

describe('decideVerdict（五态）', () => {
  it.each([
    [{ ownership: 'official', brandStatus: 'blacklist' }, 'blacklist'],
    [{ ownership: 'official', brandStatus: 'certified' }, 'certified'],
    [{ ownership: 'fake', brandStatus: 'certified' }, 'fake'],
    [{ ownership: 'official', brandStatus: 'watch' }, 'watch'],
    [{ ownership: 'pending', brandStatus: 'certified' }, 'watch'],
    [{ ownership: 'pending', brandStatus: 'blacklist' }, 'blacklist'],
    [null, 'unknown'],
  ] as const)('%j → %s', (m, v) => expect(decideVerdict(m)).toBe(v));
  it('判定语固定五句', () =>
    expect(Object.values(VERDICT_TEXT)).toEqual(['别存。', '可以存。', '这是假的。', '谨慎。', '先别存。']));
});
