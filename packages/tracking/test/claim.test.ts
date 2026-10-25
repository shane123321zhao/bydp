import { sql } from '@bydp/db';
import { describe, expect, it } from 'vitest';
import { buildTrackingUrl, claimOffer, TrackingError } from '../src/index';
import { asApp, inTx, oldClick, q, url } from './helpers';

const HOSTS = ['jinlong88.com', 'jinlong88.vip'];

describe('buildTrackingUrl（A-007 F1 第 2 层：WHATWG URL 复核）', () => {
  it('{clickId} 以 URL 编码替换；www. 前缀忽略', () => {
    expect(buildTrackingUrl('https://www.jinlong88.com/r?c={clickId}&s=1', 'a&b/c?d', HOSTS)).toBe('https://www.jinlong88.com/r?c=a%26b%2Fc%3Fd&s=1');
    expect(buildTrackingUrl('https://jinlong88.vip/{clickId}', 'clk_1', HOSTS)).toBe('https://jinlong88.vip/clk_1');
  });
  it('userinfo / 非官方主机 / 子域伪装 / http / 空模板 → null', () => {
    for (const t of [
      'https://jinlong88.com:443@evil.com/r?c={clickId}',
      'https://jinlong88.com@evil.com/r',
      'https://evil.com/r?c={clickId}',
      'https://jinlong88.com.evil.com/r',
      'http://jinlong88.com/r',
      'https://jinlong88.com\\@evil.com/r',
    ])
      expect(buildTrackingUrl(t, 'clk_1', HOSTS), t).toBeNull();
    expect(buildTrackingUrl(null, 'clk_1', HOSTS)).toBeNull();
    expect(buildTrackingUrl('https://jinlong88.com/r', 'clk_1', [])).toBeNull();
  });
});

describe.skipIf(!url)('claimOffer（bydp_app）', () => {
  const setTemplate = (tx: Parameters<Parameters<typeof inTx>[0]>[0]) =>
    tx.execute(sql`update "brand" set "redirectTemplate" = 'https://www.jinlong88.com/r?c={clickId}&s=bydp' where "id" = 'br_jinlong'`);

  it('模板替换 + 返回码；24h 内重复领码返回同一条 Click，不新写', async () => {
    const r = await inTx(async (tx) => {
      await setTemplate(tx);
      await asApp(tx);
      const a = await claimOffer(tx, { userId: 'u_102', offerId: 'of_001', channel: 'web', region: 'MY' });
      const b = await claimOffer(tx, { userId: 'u_102', offerId: 'of_001' });
      const [n] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "click" where "userId" = 'u_102' and "offerId" = 'of_001'`);
      return { a, b, n: n!.n };
    });
    expect(r.a.trackingUrl).toBe(`https://www.jinlong88.com/r?c=${encodeURIComponent(r.a.clickId)}&s=bydp`);
    expect(r.a).toMatchObject({ reused: false, code: 'BYDP-JL500' });
    expect(r.b).toEqual({ ...r.a, reused: true });
    expect(r.n).toBe(1);
  });

  it('Offer.redirectTemplate 优先于 Brand.redirectTemplate', async () => {
    const r = await inTx(async (tx) => {
      await setTemplate(tx);
      await tx.execute(sql`update "offer" set "redirectTemplate" = 'https://jinlong88.vip/o/{clickId}' where "id" = 'of_001'`);
      await asApp(tx);
      return claimOffer(tx, { userId: 'u_102', offerId: 'of_001' });
    });
    expect(r.trackingUrl).toBe(`https://jinlong88.vip/o/${r.clickId}`);
  });

  it('超过 24h 的旧 Click 不复用', async () => {
    const r = await inTx(async (tx) => {
      await oldClick(tx, 'clk_old', 'br_jinlong', '25 hours', { userId: 'u_102', offerId: 'of_001' });
      await asApp(tx);
      return claimOffer(tx, { userId: 'u_102', offerId: 'of_001' });
    });
    expect(r.reused).toBe(false);
    expect(r.clickId).not.toBe('clk_old');
  });

  it('审核条件 2：官方标识改为仿冒 / 被删除后，领码不再返回跳转链接（只返回码）', async () => {
    const r = await inTx(async (tx) => {
      await setTemplate(tx);
      await tx.execute(sql`update "identifier" set "ownership" = 'fake', "primary" = false where "brandId" = 'br_jinlong' and "value" = 'jinlong88.com'`);
      await asApp(tx);
      const faked = await claimOffer(tx, { userId: 'u_102', offerId: 'of_001' });
      await tx.execute(sql`reset role`);
      await tx.execute(sql`delete from "identifier" where "brandId" = 'br_jinlong' and "value" = 'jinlong88.com'`);
      await asApp(tx);
      const deleted = await claimOffer(tx, { userId: 'u_233', offerId: 'of_001' });
      return { faked, deleted };
    });
    expect(r.faked).toMatchObject({ trackingUrl: null, code: 'BYDP-JL500' });
    expect(r.deleted).toMatchObject({ trackingUrl: null, code: 'BYDP-JL500' });
  });

  it('无模板 → 只返回码；合作方须存在且 active；Click 带齐 slot / channel / region / partnerId', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`insert into "partner" ("id","kind","name","active") values ('pt_on','kol','A',true), ('pt_off','kol','B',false)`);
      await asApp(tx);
      const ok = await claimOffer(tx, { userId: 'u_102', offerId: 'of_003', slot: 'home_top', channel: 'tg', region: 'SG', partnerId: 'pt_on' });
      const off = await claimOffer(tx, { userId: 'u_102', offerId: 'of_001', partnerId: 'pt_off' }).catch((e) => e);
      const [click] = await q(tx, sql`select "brandId","offerId","promoCodeId","userId","partnerId","slot","channel","region" from "click" where "id" = ${ok.clickId}`);
      return { ok, off, click };
    });
    expect(r.ok).toMatchObject({ trackingUrl: null, code: null });
    expect(r.click).toEqual({ brandId: 'br_jinlong', offerId: 'of_003', promoCodeId: 'pc_003', userId: 'u_102', partnerId: 'pt_on', slot: 'home_top', channel: 'tg', region: 'SG' });
    expect(r.off).toBeInstanceOf(TrackingError);
    expect(r.off.code).toBe('partner_invalid');
  });

  it('前置校验：不存在 / 过期 / 黑名单品牌 / 关联方独家位 均拒绝且不写 Click', async () => {
    const r = await inTx(async (tx) => {
      // A-018：黑名单品牌下的 Offer 只能为 offline（触发器）
      await tx.execute(sql`insert into "offer" ("id","brandId","title","type","terms","trueValue","status") values ('of_bl','br_caishen','x','deposit','{}','{}','offline')`);
      await tx.execute(sql`update "offer" set "exclusive" = true where "id" = 'of_002'`);
      await tx.execute(sql`update "offer" set "validUntil" = current_date - 1 where "id" = 'of_003'`);
      await asApp(tx);
      const codes = [];
      for (const offerId of ['of_nope', 'of_003', 'of_bl', 'of_002'])
        codes.push(await claimOffer(tx, { userId: 'u_102', offerId }).then(() => 'ok', (e: TrackingError) => e.code));
      const [n] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "click" where "userId" = 'u_102'`);
      return { codes, n: n!.n };
    });
    expect(r.codes).toEqual(['offer_not_found', 'offer_expired', 'brand_blacklisted', 'related_party_exclusive']);
    expect(r.n).toBe(0);
  });

  it('A-018：已下线（offline）的 Offer 不可领码，不写 Click；重新上线后可领', async () => {
    const r = await inTx(async (tx) => {
      await tx.execute(sql`update "offer" set "status" = 'offline' where "id" = 'of_001'`);
      await asApp(tx);
      const off = await claimOffer(tx, { userId: 'u_102', offerId: 'of_001' }).then(() => 'ok', (e: TrackingError) => e.code);
      const [n] = await q<{ n: number }>(tx, sql`select count(*)::int as n from "click" where "userId" = 'u_102' and "offerId" = 'of_001'`);
      await tx.execute(sql`update "offer" set "status" = 'active' where "id" = 'of_001'`);
      const on = await claimOffer(tx, { userId: 'u_102', offerId: 'of_001' }).then(() => 'ok', (e: TrackingError) => e.code);
      return { off, clicks: n!.n, on };
    });
    expect(r).toEqual({ off: 'offer_expired', clicks: 0, on: 'ok' });
  });
});
