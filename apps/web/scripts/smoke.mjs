#!/usr/bin/env node
/**
 * apps/web 生产冒烟（CI）：前提是已 `next build`，DATABASE_URL 指向已 seed 的库。
 * 起 next start → 断言路由状态码、判定语、noindex、hreflang、大陆 451、不自动跳语言 → 关闭。
 */
import { spawn } from 'node:child_process';

const PORT = process.env.SMOKE_PORT ?? '3299';
const B = `http://localhost:${PORT}`;
const srv = spawn('pnpm', ['exec', 'next', 'start', '-p', PORT], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', env: process.env });
const fails = [];
const ok = (cond, msg) => (cond ? null : fails.push(msg));

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${B}/regions`)).ok) break;
    } catch {
      /* 服务尚未就绪，继续等待 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const get = (p, h = {}) => fetch(B + p, { headers: h, redirect: 'manual' });
  const ROUTES = ['/', '/brand/jinlong', '/brand/jinlong/complaints', '/brand/jinlong/withdrawal', '/brand/jinlong/domains', '/brand/jinlong/bonus', '/brand/caishen-poker', '/certified', '/watchlist', '/licensed', '/blacklist', '/watchlist?region=TW', '/offers', '/offers?filter=pos', '/regions', '/methodology', '/certification', '/official', '/disclosure', '/zh-hant', '/en/certified'];
  for (const r of ROUTES) ok((await get(r)).status === 200, `${r} 非 200`);
  ok((await get('/brand/nope')).status === 404, '/brand/nope 应 404');

  const CASES = { 'cs-poker.net': '别存。', 'jinlong88.com': '可以存。', 'jin1ong88.com': '这是假的。', 'winner-sport.co': '谨慎。', 'lucky777-my.com': '先别存。' };
  for (const [q, text] of Object.entries(CASES)) {
    const html = await (await get(`/check/${q}`)).text();
    ok(html.includes(text), `/check/${q} 缺判定语 ${text}`);
    ok(html.includes('noindex') === (q === 'lucky777-my.com'), `/check/${q} noindex 口径错误`);
  }
  const redir = await get('/check?q=jinlong88.com');
  ok(redir.status === 307 && redir.headers.get('location')?.endsWith('/check/jinlong88.com'), '/check?q= 未跳转');
  const brand = await (await get('/brand/jinlong')).text();
  // M1 只有简体定稿：hreflang 只声明 zh-Hans + x-default；繁 / 英页 noindex（自检 #12）
  ok(brand.includes('hrefLang="zh-Hans"') && brand.includes('hrefLang="x-default"') && !brand.includes('hrefLang="zh-Hant"'), 'hreflang 口径错误');
  ok((await (await get('/en/certified')).text()).includes('noindex'), '/en 未定稿译本应 noindex');
  ok(!(await (await get('/certified')).text()).includes('noindex'), '/certified 不应 noindex');
  ok(brand.includes('"AggregateRating"'), '认证品牌缺 AggregateRating');
  // D-021：条款 / 隐私政策（草稿期 noindex、顶部草稿提示、Cookie 锚点、站内链接带语言前缀、无原始 HTML 注入面）
  for (const [p, must] of [['/terms', '不是博彩运营商'], ['/privacy-policy', 'id="cookies"']]) {
    const res = await get(p);
    const html = await res.text();
    ok(res.status === 200 && html.includes('草稿，上线前补全') && html.includes('noindex') && html.includes(must), `${p} 草稿页口径错误`);
  }
  ok((await (await get('/en/terms')).text()).includes('href="/en/privacy-policy"'), '/en 法务页站内链接未带语言前缀');
  ok((await (await get('/login')).text()).includes('href="/privacy-policy"'), '登录页未挂隐私政策链接');
  ok(!(await (await get('/brand/caishen-poker')).text()).includes('"AggregateRating"'), '黑名单不应有 AggregateRating');
  const cn = await get('/brand/jinlong', { 'CF-IPCountry': 'CN' });
  ok(cn.status === 451 && (await cn.text()).includes('不在服务范围内'), '大陆 IP 未 451');
  // 自检 #2：带点路径、大小写 locale 前缀、以 regions 结尾的路径都不能绕过
  for (const p of ['/check/jinlong88.com', '/zh-Hans/check/jinlong88.com', '/zh-Hant/check/jinlong88.com', '/en/check/jinlong88.com', '/check/regions', '/zh-Hans/brand/jinlong'])
    ok((await get(p, { 'CF-IPCountry': 'CN' })).status === 451, `大陆 IP 绕过：${p}`);
  ok((await get('/regions', { 'CF-IPCountry': 'CN' })).status === 200, '/regions 声明页对大陆须可达');
  // 自检 #3：非规范形 308 到规范 URL，任意文本不进入可索引页面
  for (const [raw, canon] of [['/check/jinlong88.com%2F%E6%9F%90%E5%B9%B3%E5%8F%B0%E6%98%AF%E9%AA%97%E5%AD%90', '/check/jinlong88.com'], ['/check/JINLONG88.COM', '/check/jinlong88.com'], ['/check/https%3A%2F%2Fwww.jinlong88.com', '/check/jinlong88.com']]) {
    const res = await get(raw);
    ok(res.status === 308 && res.headers.get('location')?.endsWith(canon), `${raw} 未 308 到 ${canon}（${res.status}）`);
  }
  ok((await get('/', { 'Accept-Language': 'zh-TW' })).status === 200, '不应按语言自动跳转');
  // A-009：Auth.js 路由在线（TG + 邮箱两个 provider）；登录接口同样受大陆屏蔽（JSON 451）
  const prov = await get('/api/auth/providers');
  const provJson = prov.status === 200 ? await prov.json() : {};
  ok(prov.status === 200 && provJson.telegram && provJson.resend, `/api/auth/providers 应列出 telegram 与 resend（${prov.status}）`);
  const provCn = await get('/api/auth/providers', { 'CF-IPCountry': 'CN' });
  ok(provCn.status === 451 && (await provCn.json()).error === 'region_unavailable', '/api/auth/* 大陆 IP 未 451');
  // A-009 签核条件 3：TG 登录数据只经 POST；redirect 模式（GET 带签名参数）不被接受 → 跳错误页（D-010 起为 /login?error=），不发会话
  const tgGet = await get('/api/auth/callback/telegram?id=1&auth_date=1&hash=' + 'a'.repeat(64));
  ok(tgGet.status >= 300 && tgGet.status < 400 && /\/(api\/auth\/error|login)\?error=/.test(tgGet.headers.get('location') ?? '') && !tgGet.headers.getSetCookie().some((c) => c.includes('session-token=')), 'TG 回调 GET 应被拒');
  // D-009：非正式环境 robots.txt 全站 Disallow（CI 未设 BYDP_ENV）；不被语言路由改写
  const robots = await get('/robots.txt');
  ok(robots.status === 200 && /Disallow: \/\s*$/m.test(await robots.text()), '/robots.txt 非正式环境应全站 Disallow');
  // D-010：登录页可达（noindex）；跳回地址只接受站内路径
  const login = await get('/login?callbackUrl=https://evil.example');
  const loginHtml = login.status === 200 ? await login.text() : '';
  ok(login.status === 200 && loginHtml.includes('登录后解锁') && loginHtml.includes('noindex'), '/login 应可达且 noindex');
  // 页面数据里会带原 URL（Next 自身行为），真正用于跳回的是表单 callbackUrl，须已被替换为站内 /
  ok(/name="callbackUrl" value="\/"/.test(loginHtml), '/login 外站跳回地址应被替换为 /');
  // D-010：「我的」需登录——未登录跳登录页并带回跳地址
  const meRes = await get('/me');
  ok(meRes.status >= 300 && meRes.status < 400 && (meRes.headers.get('location') ?? '').includes('/login?callbackUrl=%2Fme') || (meRes.headers.get('location') ?? '').includes('/login?callbackUrl=/me'), `/me 未登录应跳 /login（${meRes.status} ${meRes.headers.get('location')}）`);
  const bindRes = await get('/me/bind');
  const bindLoc = bindRes.headers.get('location') ?? '';
  ok(bindRes.status >= 300 && bindRes.status < 400 && /\/login\?callbackUrl=(%2Fme%2Fbind|\/me\/bind)/.test(bindLoc), `/me/bind 未登录应跳 /login（${bindRes.status} ${bindLoc}）`);
  // D-014：05 投诉两页未登录跳登录
  for (const [path, cb] of [['/complaint?b=jinlong', '%2Fcomplaint%3Fb%3Djinlong'], ['/me/complaints/cp_001', '%2Fme%2Fcomplaints%2Fcp_001']]) {
    const res = await get(path);
    const loc = res.headers.get('location') ?? '';
    ok(res.status >= 300 && res.status < 400 && loc.includes(`/login?callbackUrl=${cb}`), `${path} 未登录应跳 /login（${res.status} ${loc}）`);
  }
  for (const sub of ['rg', 'privacy']) {
    const res = await get(`/me/${sub}`);
    const loc = res.headers.get('location') ?? '';
    ok(res.status >= 300 && res.status < 400 && new RegExp(`/login\\?callbackUrl=(%2Fme%2F${sub}|/me/${sub})`).test(loc), `/me/${sub} 未登录应跳 /login（${res.status} ${loc}）`);
  }
  // D-007：已领码 = Click 计数（CI 在 seed:demo 之后跑冒烟，demo 点击 1,834 + 212）
  ok((await (await get('/brand/jinlong/bonus')).text()).includes('1,834'), '/brand/jinlong/bonus 已领码应为 1,834（demo 点击）');
  ok((await (await get('/offers')).text()).includes('2,046'), '/offers 已领码合计应为 2,046（demo 点击）');
  // D-023：未登录「登录领码」是可点链接，跳登录页并带回跳（优惠列表 + 品牌优惠子页）
  ok((await (await get('/offers')).text()).includes('href="/login?callbackUrl=%2Foffers"'), '/offers「登录领码」应链接到 /login?callbackUrl=%2Foffers');
  ok((await (await get('/brand/jinlong/bonus')).text()).includes('href="/login?callbackUrl=%2Fbrand%2Fjinlong%2Fbonus"'), '/brand/jinlong/bonus 应有「登录领码」链接');
  ok(!(await (await get('/brand/caishen-poker/bonus')).text()).includes('登录领码'), '黑名单品牌优惠页不应有领码入口');
} finally {
  srv.kill('SIGTERM');
}
if (fails.length) {
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('web smoke OK');
