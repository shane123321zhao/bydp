/**
 * Next 16 Proxy：① 大陆屏蔽应用层兜底（ADR-0007，边缘 WAF 为主）→ 改写到 /regions 声明页，状态 451；
 * ② next-intl 语言路由（不做语言自动跳转）。与语言逻辑解耦：先判地区，再走语言。
 * ③ D-015 #2：设备标识 cookie（bydp_did，随机 128 bit，httpOnly）缺失即下发；登录时只以其 HMAC 入库，用于同设备多账号标记（只标不拦）。
 */
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';

const intl = createMiddleware(routing);
// 仅豁免声明页本身（含语言前缀，大小写不敏感）；审查 #2：旧写法以 /regions 结尾即豁免，可被 /check/regions 绕过
const REGIONS = /^\/(?:(?:zh-hans|zh-hant|en)\/)?regions\/?$/i;
const BLOCKED = new Set((process.env.GEO_BLOCK_COUNTRIES ?? 'CN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

// D-020 #3：auth-admin 实例（后台子域）只提供登录相关路径，其余一律 404——主站页面（含 UGC）不得与后台同源（Caddy 同样只转这些路径）
const ADMIN_SCOPE_PATHS = /^\/(?:(?:zh-hans|zh-hant|en)\/)?(?:login|regions)\/?$|^\/api\/auth\//i;

export function proxy(req: NextRequest) {
  // 后台子域实例不执行任何 server action（主站的 action 只认 id 不认路径，自检 S13）：带 Next-Action 头一律 404
  if (process.env.BYDP_AUTH_SCOPE === 'admin' && (!ADMIN_SCOPE_PATHS.test(req.nextUrl.pathname) || req.headers.has('next-action'))) {
    return new NextResponse('Not Found', { status: 404 });
  }
  const cc = req.headers.get('cf-ipcountry')?.toUpperCase();
  if (cc && BLOCKED.has(cc) && !REGIONS.test(req.nextUrl.pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = `/${routing.defaultLocale}/regions`; // 直接指向 [locale] 段（改写不经过 next-intl）
    url.search = '?blocked=1';
    // /api/*（登录等）返回 JSON 451，不改写到页面
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'region_unavailable', message: '本服务不向中国大陆居民提供。', regions: '/regions' }, { status: 451 });
    }
    return NextResponse.rewrite(url, { status: 451 });
  }
  // /api/*（Auth.js 登录回调）只做地区判断，不走语言路由
  const res = req.nextUrl.pathname.startsWith('/api/') ? NextResponse.next() : intl(req);
  if (!req.cookies.has(DEVICE_COOKIE)) {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    res.cookies.set(DEVICE_COOKIE, id, { httpOnly: true, secure: req.nextUrl.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: 400 * 86400 });
  }
  return res;
}

/** 与 @bydp/core/identity/device DEVICE_COOKIE 同名（proxy 运行于边缘运行时，不引入 core 的 node:crypto 依赖） */
const DEVICE_COOKIE = 'bydp_did';

export const config = {
  // 审查 #2：不再按"带点即静态文件"排除——/check/{域名} 与 /zh-Hans/... 等直达 [locale] 的路径都必须经过地区判断。
  // A-009：/api/auth/* 登录同样须经大陆屏蔽（此前 matcher 排除了 api/）。只排除 Next 内部资源、app 图标与 robots.txt（D-009：避免被语言路由改写）。
  matcher: ['/((?!_next/|_vercel/|icon\\.svg$|favicon\\.ico$|robots\\.txt$).*)'],
};
