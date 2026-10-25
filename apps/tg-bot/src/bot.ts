/**
 * BYDP Telegram Bot（D-017 · grammY）：/start 声明 · /check 查验 · /offers 领码 · /cases 投诉进度 · /sub /unsub 订阅。
 * - 全部命令复用 @bydp/core（与站内 / api 同一规则：自我排除、黑名单、24h 领码、本人案件、订阅守卫），不绕规则；
 * - 只以 bydp_app 连接数据库；TG 用户须先在站内用 Telegram 登录过（Login Widget），Bot 不建账号；
 * - 回复一律纯文本（不用 parse_mode），不回显账号 / 联系方式 / 投诉原文；对外错误统一；
 * - 每个 TG 用户每分钟 ≤ 20 条命令（Redis 计数，超限只提示一次）；
 * - **只在私聊中响应**（审核 D-017）：在群 / 频道里任何命令与按钮只回「请私聊使用」，不回个人数据。
 */
import { CLAIM_REJECT, claimOfferForUser, TrackingError } from '@bydp/core/commerce/tracking';
import { getOffers } from '@bydp/core/commerce/offers';
import { listMyComplaints } from '@bydp/core/complaint/mine';
import { findUserByTelegramId, type RateCounter } from '@bydp/core/identity/auth';
import { findBrandForSubscription, MeInputError, subscribe, unsubscribe } from '@bydp/core/identity/me';
import { getSelfExclusion, SelfExcludedError } from '@bydp/core/identity/self-exclusion';
import type { CoreDb } from '@bydp/core/runtime';
import { VERDICT_TEXT } from '@bydp/core/trust';
import { checkIdentifier } from '@bydp/core/trust/check';
import { recordCandidateQuery } from '@bydp/core/trust/candidate-queries';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

export const START_TEXT =
  '博弈点评 BYDP 是独立的博彩平台评测与投诉处理平台。我们不是博彩运营商，不收款、不代充、不索要你的账号密码——任何以 BYDP 名义要求转账或密码的都是诈骗。使用本服务须年满 18 岁；中国大陆地区不提供服务。命令：/check 查验 · /offers 优惠 · /cases 我的投诉 · /sub 订阅。';
export const RATE_LIMIT = { perMinute: 20 } as const;
const GENERIC_ERROR = '暂时无法处理，请稍后再试。';

export type BotDeps = {
  db: CoreDb;
  hmacKey: Buffer;
  counter: RateCounter;
  /** 站点根地址（如 https://staging.northx.vip），用于站内链接 */
  siteUrl: string;
  token: string;
  /** 测试注入，跳过 getMe */
  botInfo?: UserFromGetMe;
};

const VERDICT_TAG: Record<string, string> = { blacklist: '黑名单', certified: '平台认证', fake: '仿冒', watch: '观察', unknown: '未收录' };
const argOf = (ctx: Context) => (typeof ctx.match === 'string' ? ctx.match.trim() : '');

export function createBot(d: BotDeps): Bot {
  const bot = new Bot(d.token, d.botInfo ? { botInfo: d.botInfo } : undefined);
  const link = (path: string) => `${d.siteUrl.replace(/\/$/, '')}${path}`;
  const loginHint = `请先在站内用 Telegram 登录一次：${link('/login')}`;

  // 限流（每个 TG 用户每分钟 ≤ 20 条；超限只在第 21 条时提示一次，之后静默）
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    const n = await d.counter.hit(`tg:cmd:${uid}`, 60);
    if (n > RATE_LIMIT.perMinute) {
      if (n === RATE_LIMIT.perMinute + 1) await ctx.reply('操作过于频繁，请一分钟后再试。');
      return;
    }
    await next();
  });

  // 只在私聊中响应（放在限流之后，群里刷命令同样受每人每分钟上限约束）：只有确认是私聊才放行——群 / 频道 / 无法判定来源（如内联消息按钮）回一句后结束；不处理非命令的群消息
  bot.use(async (ctx, next) => {
    const type = ctx.chat?.type ?? ctx.callbackQuery?.message?.chat.type;
    if (type !== 'private') {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '请私聊机器人使用', show_alert: true }).catch(() => {});
      else if (ctx.message?.text?.startsWith('/')) await ctx.reply('请私聊机器人使用，群里不提供查询与领码。').catch(() => {});
      return;
    }
    await next();
  });

  const userOf = async (ctx: Context) => (ctx.from ? findUserByTelegramId(d.db, String(ctx.from.id), { hmacKey: d.hmacKey }) : null);

  bot.command('start', (ctx) => ctx.reply(START_TEXT, { link_preview_options: { is_disabled: true } }));
  bot.command('help', (ctx) => ctx.reply(START_TEXT, { link_preview_options: { is_disabled: true } }));

  bot.command('check', async (ctx) => {
    const q = argOf(ctx).slice(0, 256);
    if (!q) return void (await ctx.reply('用法：/check 域名或 Telegram 账号，例如 /check example.com'));
    const r = await checkIdentifier(d.db, q);
    const lines = [`${VERDICT_TEXT[r.verdict]}（${VERDICT_TAG[r.verdict] ?? r.verdict}）`];
    if (r.brand?.name?.zhHans) lines.push(`品牌：${r.brand.name.zhHans}`);
    if (r.matchNote) lines.push(r.matchNote);
    for (const f of (r.facts ?? []).slice(0, 3)) lines.push(`· ${f.k}：${f.v}`);
    const value = r.normalized?.value ?? q;
    lines.push(`详情：${link(`/check/${encodeURIComponent(value)}`)}`);
    await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
    // 未收录 → Candidate 计数（查询者 = TG 用户 id 的 HMAC，不存原值；失败不影响回复）
    if (r.verdict === 'unknown' && r.normalized?.type && r.normalized.value && ctx.from) {
      await recordCandidateQuery(d.db, { type: r.normalized.type, value: r.normalized.value }, { ip: null, deviceId: null, userAgent: null, tgUserId: String(ctx.from.id) }, d.hmacKey).catch(
        (e: Error) => console.error(JSON.stringify({ evt: 'tg_candidate_record_failed', error: e.message.slice(0, 120) })),
      );
    }
  });

  bot.command('offers', async (ctx) => {
    // 自我排除期内不展示优惠列表（Bot 能识别身份；审核 D-017 提醒）
    const me = await userOf(ctx);
    if (me) {
      const ex = await getSelfExclusion(d.db, me.userId);
      if (ex) return void (await ctx.reply(ex.endsAt ? `你处于自我排除期（至 ${ex.endsAt.slice(0, 10)}），期间不展示优惠。` : '你已永久自我排除，不展示优惠。'));
    }
    const page = await getOffers(d.db, 'all');
    const items = (page.items ?? []).slice(0, 5);
    if (!items.length) return void (await ctx.reply('暂无可领取的优惠。'));
    const kb = new InlineKeyboard();
    const lines = items.map((o, i) => {
      kb.text(`领码 ${i + 1}`, `claim:${o.id}`).row();
      const risk = o.riskLabel ? ` · ${o.riskLabel}` : '';
      const ad = o.sponsored ? ' · 赞助' : '';
      return `${i + 1}. ${o.brand?.name?.zhHans ?? ''} · ${o.title ?? ''}${risk}${ad}`;
    });
    await ctx.reply(`${lines.join('\n')}\n\n领码前须已在站内用 Telegram 登录。全部优惠：${link('/offers')}`, { reply_markup: kb, link_preview_options: { is_disabled: true } });
  });

  bot.callbackQuery(/^claim:([A-Za-z0-9_]{1,64})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await userOf(ctx);
    if (!u) return void (await ctx.reply(loginHint, { link_preview_options: { is_disabled: true } }));
    try {
      const r = await claimOfferForUser(d.db, { userId: u.userId, offerId: ctx.match[1]!, region: null });
      const lines = [r.code ? `优惠码：${r.code}` : '已为你记录领取。', r.trackingUrl ? `前往官网：${r.trackingUrl}` : '官网链接待核验，请稍后在站内查看。'];
      if (r.riskLabel) lines.push(`风险提示：${r.riskLabel}`);
      await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (e instanceof SelfExcludedError) return void (await ctx.reply('自我排除期内，不可领码。'));
      if (e instanceof TrackingError) return void (await ctx.reply(CLAIM_REJECT[e.code]?.body.message ?? GENERIC_ERROR));
      throw e;
    }
  });

  bot.command('cases', async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return void (await ctx.reply(loginHint, { link_preview_options: { is_disabled: true } }));
    const rows = await listMyComplaints(d.db, u.userId, 10);
    if (!rows.length) return void (await ctx.reply('你还没有投诉记录。'));
    const lines = rows.map((c) => `#${c.id.slice(-8)} · ${c.brandName} · ${c.statusText} · ${c.amountUsdt.toLocaleString('en-US')} USDT\n${link(`/me/complaints/${c.id}`)}`);
    await ctx.reply(lines.join('\n\n'), { link_preview_options: { is_disabled: true } });
  });

  const subTarget = async (q: string): Promise<{ targetType: 'brand' | 'complaint'; targetId: string; label: string } | null> => {
    if (/^cp_[A-Za-z0-9]{1,60}$/.test(q)) return { targetType: 'complaint', targetId: q, label: `投诉 #${q.slice(-8)}` };
    const b = await findBrandForSubscription(d.db, q);
    return b ? { targetType: 'brand', targetId: b.id, label: b.name } : null;
  };
  bot.command('sub', async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return void (await ctx.reply(loginHint, { link_preview_options: { is_disabled: true } }));
    const q = argOf(ctx);
    if (!q) return void (await ctx.reply('用法：/sub 品牌（如 /sub jinlong）或 /sub 案件编号（cp_ 开头）'));
    const t = await subTarget(q);
    if (!t) return void (await ctx.reply('没有找到该品牌或案件。'));
    try {
      await subscribe(d.db, u.userId, { targetType: t.targetType, targetId: t.targetId, channel: 'telegram' });
    } catch (e) {
      if (e instanceof MeInputError) return void (await ctx.reply('没有找到该品牌或案件。'));
      throw e;
    }
    await ctx.reply(`已订阅：${t.label}。有状态变更会在这里通知你。取消：/unsub ${q}`);
  });
  bot.command('unsub', async (ctx) => {
    const u = await userOf(ctx);
    if (!u) return void (await ctx.reply(loginHint, { link_preview_options: { is_disabled: true } }));
    const t = await subTarget(argOf(ctx));
    if (!t) return void (await ctx.reply('用法：/unsub 品牌或案件编号'));
    await ctx.reply((await unsubscribe(d.db, u.userId, t)) ? `已取消订阅：${t.label}。` : '你没有订阅该对象。');
  });

  bot.on('message', (ctx) => ctx.reply('可用命令：/check 查验 · /offers 优惠 · /cases 我的投诉 · /sub 订阅。'));

  // 统一错误：只记事件类型，不记消息内容；对外固定文案
  bot.catch(async (err) => {
    console.error(JSON.stringify({ evt: 'tg_bot_error', name: (err.error as Error)?.name, message: String((err.error as Error)?.message ?? '').slice(0, 120) }));
    await err.ctx.reply(GENERIC_ERROR).catch(() => {});
  });
  return bot;
}
