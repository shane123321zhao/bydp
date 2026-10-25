/** 投诉通知（M2）：文案 · 同事务生成 · 推送选渠道。推送用假发送函数，不发真实 TG / 邮件 */
import { randomBytes } from 'node:crypto';
import { createDb, sql } from '@bydp/db';
import { afterAll, describe, expect, it } from 'vitest';
import { submitComplaint, transitionComplaint } from '../src/complaint/write';
import type { ComplaintStatus } from '../src/complaint/state';
import { signInWithIdentity } from '../src/identity/auth';
import { complaintNotice } from '../src/notify/complaint';
import { deliverNotification, telegramSender, uatTestEmailMatcher } from '../src/notify/deliver';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL');
const conn = url ? createDb(url) : undefined;
afterAll(async () => conn?.client.end());
const keys = { hmacKey: randomBytes(32), piiKey: randomBytes(32) };
type Tx = Parameters<Parameters<NonNullable<typeof conn>['db']['transaction']>[0]>[0];
const COMPLAINT = { brandId: 'br_winner', category: 'refused' as const, amountUsdt: 1200, eventDate: '2026-09-20', description: 'x' };

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await conn!.db
    .transaction(async (tx) => {
      await tx.execute(sql`set local role bydp_app`);
      out = await fn(tx);
      tx.rollback();
    })
    .catch((e: Error) => {
      if (!/rollback/i.test(e.message)) throw e;
    });
  return out as T;
}

describe('complaintNotice 文案', () => {
  const ALL: ComplaintStatus[] = ['screening', 'accepted', 'awaiting_reply', 'arbitrating', 'resolved', 'rejected', 'unresolved', 'exposed'];
  it('全部状态有标题与正文，不含禁用词；驳回带原因；答辩期带截止日期', () => {
    for (const s of ALL) {
      const n = complaintNotice(s, { id: 'cp_1', replyDeadline: new Date('2026-10-06T00:00:00Z'), reason: '重复提交' });
      expect(n.title).toMatch(/^投诉 #cp_1 /);
      expect(`${n.title}${n.body}`).not.toMatch(/保险|留存率/);
    }
    expect(complaintNotice('rejected', { id: 'cp_1', reason: '重复提交' }).body).toContain('原因：重复提交');
    expect(complaintNotice('awaiting_reply', { id: 'cp_1', replyDeadline: new Date('2026-10-06T00:00:00Z') }).body).toContain('2026-10-06');
  });
});

describe.skipIf(!url)('同事务生成通知', () => {
  it('提交 → 投诉人收到「已提交」；受理 → 订阅者也收到；驳回原因只发投诉人', async () => {
    const r = await inTx(async (tx) => {
      const c = await submitComplaint(tx, 'u_102', COMPLAINT);
      await tx.execute(sql`insert into "subscription" ("id","userId","targetType","targetId") values ('sub_t','u_233','complaint',${c.id})`);
      const acc = await transitionComplaint(tx, c.id, 'accepted', { id: 'arb' });
      const c2 = await submitComplaint(tx, 'u_102', COMPLAINT);
      await tx.execute(sql`insert into "subscription" ("id","userId","targetType","targetId") values ('sub_t2','u_233','complaint',${c2.id})`);
      const rej = await transitionComplaint(tx, c2.id, 'rejected', { id: 'arb', reason: '重复提交' });
      const rows = (await tx.execute(
        sql`select "userId", "title", "body" from "notification" where "title" like ${`%${c.id}%`} or "title" like ${`%${c2.id}%`} order by "title", "userId"`,
      )) as unknown as { userId: string; title: string; body: string }[];
      return { c, acc, rej, rows };
    });
    expect(r.c.notificationIds).toHaveLength(1);
    expect(r.acc.notificationIds).toHaveLength(2);
    expect(r.rej.notificationIds).toHaveLength(1);
    const byUser = (u: string) => r.rows.filter((x) => x.userId === u).map((x) => x.title.replace(/#cp_\w+/, '#…'));
    expect(byUser('u_102').sort()).toEqual(['投诉 #… 已受理', '投诉 #… 已提交', '投诉 #… 已提交', '投诉 #… 未受理'].sort());
    expect(byUser('u_233')).toEqual(['投诉 #… 已受理']);
    expect(r.rows.find((x) => x.title.endsWith('未受理'))!.body).toContain('重复提交');
  });
});

describe.skipIf(!url)('推送选渠道（假发送）', () => {
  it('TG 用户 → Bot 私信（chat_id = TG id，结尾带大陆排除声明）；屏蔽 Bot → skipped；邮箱用户 → 邮件；无联系方式 / 不存在 → skipped', async () => {
    const tg: { chat: string; text: string }[] = [];
    const mails: { to: string; subject: string }[] = [];
    let blocked = false;
    const deps = {
      keys,
      telegram: () => async (chat: string, text: string) => (blocked ? ('blocked' as const) : (tg.push({ chat, text }), 'ok' as const)),
      email: () => async (m: { to: string; subject: string }) => void mails.push({ to: m.to, subject: m.subject }),
      emailFrom: () => 'BYDP <no-reply@mail.northx.vip>',
    };
    const r = await inTx(async (tx) => {
      const tgUser = await signInWithIdentity(tx, { provider: 'telegram', account: '424242', handle: '@am***' }, keys);
      const emUser = await signInWithIdentity(tx, { provider: 'email', account: 'Ke.Li@gmail.com', handle: 'ke***@g***.com' }, keys);
      const mk = async (u: string, tag = 't') => {
        const id = `nt_${tag}_${u.slice(-6)}`;
        await tx.execute(sql`insert into "notification" ("id","userId","type","title","body") values (${id}, ${u}, 'complaint_status', '投诉 #cp_x 已受理', '正文')`);
        return id;
      };
      const a = await deliverNotification(tx, await mk(tgUser.userId), deps);
      // A-010：已回写 deliveredAt 的通知再次投递 → 不重发
      const again = await deliverNotification(tx, `nt_t_${tgUser.userId.slice(-6)}`, deps);
      blocked = true;
      const b = await deliverNotification(tx, await mk(tgUser.userId, 'b'), deps);
      const c = await deliverNotification(tx, await mk(emUser.userId), deps);
      const seedUser = await deliverNotification(tx, await mk('u_102'), deps);
      const none = await deliverNotification(tx, 'nt_nope', deps);
      const marks = (await tx.execute(
        sql`select "id", "channel", "deliveredAt" is not null as "d", "skipReason" from "notification" where "id" like 'nt\_%\_%' escape '\' and "id" <> 'nt_nope' and "type" = 'complaint_status' and "title" = '投诉 #cp_x 已受理' order by "id"`,
      )) as unknown as { id: string; channel: string | null; d: boolean; skipReason: string | null }[];
      // A-012 #19：已跳过的不再重试
      const skippedAgain = await deliverNotification(tx, `nt_t_${'u_102'.slice(-6)}`, deps);
      return { a, again, b, c, seedUser, none, skippedAgain, marks: marks.map((m) => [m.id.split('_')[1], m.channel, m.d, m.skipReason]) };
    });
    expect(r.a).toEqual({ status: 'sent', channel: 'telegram' });
    expect(tg[0]).toMatchObject({ chat: '424242' });
    expect(tg[0]!.text).toContain('不向中国大陆居民提供服务');
    expect(r.again).toEqual({ status: 'skipped', reason: 'already_delivered' });
    expect(tg).toHaveLength(1);
    expect(r.b).toEqual({ status: 'skipped', reason: 'tg_blocked' });
    expect(r.c).toEqual({ status: 'sent', channel: 'email' });
    expect(mails).toEqual([{ to: 'ke.li@gmail.com', subject: 'BYDP 博弈点评 · 投诉 #cp_x 已受理' }]);
    expect(r.seedUser).toEqual({ status: 'skipped', reason: 'no_contact' });
    expect(r.none).toEqual({ status: 'skipped', reason: 'not_found' });
    // 推送成功才回写 deliveredAt + channel；屏蔽 / 无联系方式保持未推送
    expect(r.marks).toEqual(
      expect.arrayContaining([
        ['t', 'telegram', true, null],
        ['b', null, false, 'tg_blocked'],
        ['t', 'email', true, null],
        ['t', null, false, 'no_contact'],
      ]),
    );
    expect(r.skippedAgain).toEqual({ status: 'skipped', reason: 'already_skipped' });
    expect(r.marks).toHaveLength(4);
  });

  it('W2#023：测试站 UAT 测试账号邮箱 → 记 no_contact 跳过、不发信；普通邮箱用户照常发；识别只在 staging 生效', async () => {
    const mails: string[] = [];
    const isTestEmail = uatTestEmailMatcher({ BYDP_ENV: 'staging', UAT_MAILBOX_LOCALPART: 'bydp.uat' });
    const deps = { keys, telegram: () => async () => 'ok' as const, email: () => async (m: { to: string }) => void mails.push(m.to), emailFrom: () => 'BYDP <no-reply@mail.northx.vip>', isTestEmail };
    const r = await inTx(async (tx) => {
      const t = await signInWithIdentity(tx, { provider: 'email', account: 'bydp.uat+uat2610240101da@gmail.com', handle: 'by***@g***.com' }, keys);
      const u = await signInWithIdentity(tx, { provider: 'email', account: 'real.user@gmail.com', handle: 're***@g***.com' }, keys);
      const mk = async (uid: string, tag: string) => {
        const id = `nt_${tag}_${uid.slice(-6)}`;
        await tx.execute(sql`insert into "notification" ("id","userId","type","title","body") values (${id}, ${uid}, 'submission_decision', '出款凭证未通过', 'UAT 自动清理')`);
        return id;
      };
      const test = await deliverNotification(tx, await mk(t.userId, 'u'), deps);
      const real = await deliverNotification(tx, await mk(u.userId, 'r'), deps);
      const [row] = (await tx.execute(sql`select "skipReason", "deliveredAt" is null as "pending" from "notification" where "id" = ${`nt_u_${t.userId.slice(-6)}`}`)) as unknown as { skipReason: string; pending: boolean }[];
      return { test, real, row };
    });
    expect(r.test).toEqual({ status: 'skipped', reason: 'no_contact' });
    expect(r.row).toEqual({ skipReason: 'no_contact', pending: true }); // 站内通知仍在，只是不推送；补推扫描不再重排
    expect(r.real).toEqual({ status: 'sent', channel: 'email' });
    expect(mails).toEqual(['real.user@gmail.com']);
    expect(uatTestEmailMatcher({ BYDP_ENV: 'production', UAT_MAILBOX_LOCALPART: 'bydp.uat' })).toBeUndefined();
    expect(uatTestEmailMatcher({})).toBeUndefined();
    const loose = uatTestEmailMatcher({ BYDP_ENV: 'staging' })!; // 失败即关：未配置本地部分时任何 +uat 别名都算测试账号
    expect(loose('someone+uat1@gmail.com')).toBe(true);
    expect(loose('someone@gmail.com')).toBe(false);
    expect(isTestEmail!('other+uat1@gmail.com')).toBe(false);
  });

  it('telegramSender：403 → blocked；其他非 2xx 抛错且不回显 token', async () => {
    const f = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await telegramSender('123:SECRET', f(200))('1', 'x')).toBe('ok');
    expect(await telegramSender('123:SECRET', f(403))('1', 'x')).toBe('blocked');
    const err = await telegramSender('123:SECRET', f(500))('1', 'x').catch((e: Error) => e.message);
    expect(err).toMatch(/HTTP 500/);
    expect(err).not.toContain('SECRET');
  });
});
