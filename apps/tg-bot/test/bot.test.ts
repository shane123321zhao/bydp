/** TG Bot（D-017）：经 handleUpdate 驱动，出站 API 调用被拦截记录（不联网）。DB 用例需 DATABASE_URL（事务内执行后回滚） */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { MemoryRateCounter, signInWithIdentity } from '@bydp/core/identity/auth';
import { connect, type CoreDb } from '@bydp/core/runtime';
import { webhookCallback } from 'grammy';
import type { Update } from 'grammy/types';
import { afterAll, describe, expect, it } from 'vitest';
import { createBot, RATE_LIMIT, START_TEXT } from '../src/bot';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? connect(url) : undefined;
afterAll(async () => conn?.client.end());
const botInfo = { id: 1, is_bot: true, first_name: 'BYDP', username: 'BYDP_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
const keys = { hmacKey: randomBytes(32), piiKey: randomBytes(32) };
let seq = 1;
const msg = (from: number, text: string, chat: 'private' | 'group' = 'private'): Update => ({
  update_id: seq++,
  message: { message_id: seq, date: 0, chat: (chat === 'private' ? { id: from, type: 'private', first_name: 'u' } : { id: -100, type: 'group', title: 'g' }) as never, from: { id: from, is_bot: false, first_name: 'u' }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [] },
});
const cb = (from: number, data: string, chat: 'private' | 'group' = 'private'): Update => ({
  update_id: seq++,
  callback_query: { id: String(seq), chat_instance: 'x', data, from: { id: from, is_bot: false, first_name: 'u' }, message: { message_id: 1, date: 0, chat: chat === 'private' ? { id: from, type: 'private', first_name: 'u' } : { id: -100, type: 'group', title: 'g' }, text: 'x' } as never },
});

function harness(db: CoreDb, counter = new MemoryRateCounter()) {
  const bot = createBot({ db, hmacKey: keys.hmacKey, counter, siteUrl: 'https://site.test', token: '1:x', botInfo });
  const out: { method: string; text?: string; markup?: unknown }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { text?: string; reply_markup?: unknown };
    out.push({ method, text: p.text, markup: p.reply_markup });
    return { ok: true, result: (method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '' } : true) as never };
  });
  const send = async (u: Update) => bot.handleUpdate(u);
  return { bot, out, send };
}

async function inTx<T>(fn: (db: CoreDb) => Promise<T>): Promise<T> {
  let res!: T;
  const RB = new Error('rb');
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute('set local role bydp_app' as never);
      res = await fn(tx as unknown as CoreDb);
      throw RB;
    })
    .catch((e) => {
      if (e !== RB) throw e;
    });
  return res;
}

describe.skipIf(!url)('命令', () => {
  it('/start 声明原文；/check 回五态之一 + 站内链接；未收录进 Candidate（TG 查询者）', async () => {
    const r = await inTx(async (db) => {
      const h = harness(db);
      await h.send(msg(1001, '/start'));
      await h.send(msg(1001, '/check jinlong88.com'));
      await h.send(msg(1001, '/check never-seen-tg.com'));
      const [c] = (await db.execute(`select "queryCount7d", "weightedPriority"::float as w from "candidate" where "value" = 'never-seen-tg.com'` as never)) as unknown as { queryCount7d: number; w: number }[];
      return { out: h.out.map((o) => o.text), cand: c };
    });
    expect(r.out[0]).toBe(START_TEXT);
    expect(r.out[1]).toMatch(/^(别存。|可以存。|这是假的。|谨慎。|先别存。)/);
    expect(r.out[1]).toContain('https://site.test/check/jinlong88.com');
    expect(r.out[2]).toMatch(/^先别存。（未收录）/);
    expect(r.cand).toEqual({ queryCount7d: 1, w: 1 });
  });

  it('未在站内用 TG 登录：/offers 可看，点「领码」与 /cases /sub 都提示先登录；登录后领码成功并在站内生成同一用户的 Click', async () => {
    const r = await inTx(async (db) => {
      const h = harness(db);
      await h.send(msg(2002, '/offers'));
      const kb = h.out[0]!.markup as { inline_keyboard: { callback_data: string }[][] };
      const data = kb.inline_keyboard[0]![0]!.callback_data;
      await h.send(cb(2002, data));
      await h.send(msg(2002, '/cases'));
      const anon = h.out.map((o) => o.text ?? o.method);
      // 站内用 TG 登录一次（同一盲索引口径）
      const u = await signInWithIdentity(db, { provider: 'telegram', account: '2002', handle: '@u' }, keys);
      h.out.length = 0;
      await h.send(cb(2002, data));
      const [click] = (await db.execute(`select "userId", "offerId" from "click" where "userId" = '${u.userId}' order by "createdAt" desc limit 1` as never)) as unknown as { userId: string; offerId: string }[];
      return { anon, linked: h.out.map((o) => o.text ?? o.method), click, offerId: data.slice('claim:'.length), userId: u.userId };
    });
    expect(r.anon[0]).toMatch(/^1\. /);
    expect(r.anon.filter((t) => t?.includes('请先在站内用 Telegram 登录一次：https://site.test/login'))).toHaveLength(2);
    expect(r.linked.some((t) => /优惠码：|已为你记录领取。/.test(t ?? ''))).toBe(true);
    expect(r.click).toEqual({ userId: r.userId, offerId: r.offerId });
  });

  it('/cases 只列本人案件（状态 + 品牌，无标题 / 原文）；/sub 品牌与案件写订阅（channel = telegram），/unsub 删除', async () => {
    const r = await inTx(async (db) => {
      const h = harness(db);
      const u = await signInWithIdentity(db, { provider: 'telegram', account: '3003', handle: '@v' }, keys);
      await db.execute(`reset role` as never);
      await db.execute(`insert into "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","status") values ('cp_tgtest01','br_winner','${u.userId}','delay','标题不应出现',300,'2026-09-20','原文不应出现','screening')` as never);
      await db.execute(`set local role bydp_app` as never);
      await h.send(msg(3003, '/cases'));
      await h.send(msg(3003, '/sub winner-sports'));
      await h.send(msg(3003, '/sub cp_tgtest01'));
      const subs = (await db.execute(`select "targetType", "channel" from "subscription" where "userId" = '${u.userId}' order by "targetType"` as never)) as unknown as { targetType: string; channel: string }[];
      await h.send(msg(3003, '/unsub winner-sports'));
      const after = (await db.execute(`select count(*)::int as n from "subscription" where "userId" = '${u.userId}'` as never)) as unknown as { n: number }[];
      return { out: h.out.map((o) => o.text ?? ''), subs, after: after[0]!.n };
    });
    expect(r.out[0]).toContain('赢家体育 · 待初筛 · 300 USDT');
    expect(r.out[0]).not.toMatch(/标题不应出现|原文不应出现/);
    expect(r.subs).toEqual([{ targetType: 'brand', channel: 'telegram' }, { targetType: 'complaint', channel: 'telegram' }]);
    expect(r.out[3]).toMatch(/^已取消订阅：赢家体育/);
    expect(r.after).toBe(1);
  });

  it('群聊里不响应个人数据（审核 D-017）：命令只回「请私聊」，按钮只弹提示；排除期用户 /offers 不展示列表', async () => {
    const r = await inTx(async (db) => {
      const h = harness(db);
      const u = await signInWithIdentity(db, { provider: 'telegram', account: '6006', handle: '@g' }, keys);
      for (const t of ['/cases', '/offers', '/check jinlong88.com', '/sub winner-sports']) await h.send(msg(6006, t, 'group'));
      await h.send(cb(6006, 'claim:of_001', 'group'));
      await h.send(msg(6006, '随便聊聊', 'group'));
      const group = h.out.map((o) => `${o.method}:${o.text ?? ''}`);
      await db.execute(`insert into "self_exclusion" ("id","userId","period") values ('se_tg','${u.userId}','30')` as never);
      h.out.length = 0;
      await h.send(msg(6006, '/offers'));
      const clicks = (await db.execute(`select count(*)::int as n from "click" where "userId" = '${u.userId}'` as never)) as unknown as { n: number }[];
      return { group, offers: h.out.map((o) => o.text), clicks: clicks[0]!.n };
    });
    expect(r.group.filter((x) => x === 'sendMessage:请私聊机器人使用，群里不提供查询与领码。')).toHaveLength(4);
    expect(r.group.filter((x) => x.startsWith('answerCallbackQuery'))).toHaveLength(1);
    expect(r.group).toHaveLength(5); // 非命令群消息不回
    expect(r.offers[0]).toMatch(/^你处于自我排除期（至 \d{4}-\d{2}-\d{2}），期间不展示优惠。$/);
    expect(r.clicks).toBe(0);
  });

  it('无法判定为私聊（内联消息按钮，无 message）→ 只弹提示；永久排除用户 /offers 不展示列表', async () => {
    const r = await inTx(async (db) => {
      const h = harness(db);
      const u = await signInWithIdentity(db, { provider: 'telegram', account: '6106', handle: '@p' }, keys);
      await h.send({ update_id: seq++, callback_query: { id: 'i1', chat_instance: 'x', data: 'claim:of_001', from: { id: 6106, is_bot: false, first_name: 'u' }, inline_message_id: 'im1' } } as Update);
      const inline = h.out.map((o) => o.method);
      await db.execute(`insert into "self_exclusion" ("id","userId","period") values ('se_tgp','${u.userId}','permanent')` as never);
      h.out.length = 0;
      await h.send(msg(6106, '/offers'));
      const clicks = (await db.execute(`select count(*)::int as n from "click" where "userId" = '${u.userId}'` as never)) as unknown as { n: number }[];
      return { inline, offers: h.out.map((o) => o.text), clicks: clicks[0]!.n };
    });
    expect(r.inline).toEqual(['answerCallbackQuery']);
    expect(r.offers).toEqual(['你已永久自我排除，不展示优惠。']);
    expect(r.clicks).toBe(0);
  });

  it(`限流：每分钟第 ${RATE_LIMIT.perMinute + 1} 条起不再处理，只提示一次`, async () => {
    const r = await inTx(async (db) => {
      const h = harness(db);
      for (let i = 0; i < RATE_LIMIT.perMinute + 5; i++) await h.send(msg(4004, '/start'));
      return h.out.map((o) => o.text);
    });
    expect(r.filter((t) => t === START_TEXT)).toHaveLength(RATE_LIMIT.perMinute);
    expect(r.filter((t) => t?.startsWith('操作过于频繁'))).toHaveLength(1);
  });
});

describe('webhook secret', () => {
  it('缺少或错误的 X-Telegram-Bot-Api-Secret-Token → 401，正确 → 200', async () => {
    const bot = createBot({ db: {} as CoreDb, hmacKey: keys.hmacKey, counter: new MemoryRateCounter(), siteUrl: 'https://site.test', token: '1:x', botInfo });
    bot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '' } as never }));
    const secret = 'a'.repeat(40);
    const handle = webhookCallback(bot, 'http', { secretToken: secret });
    const server = http.createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(msg(5005, '/start')) }).then((r) => r.status);
    const statuses = [await post({}), await post({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }), await post({ 'X-Telegram-Bot-Api-Secret-Token': secret })];
    await new Promise<void>((r) => server.close(() => r()));
    expect(statuses).toEqual([401, 401, 200]);
  });
});
