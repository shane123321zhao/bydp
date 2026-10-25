import { raw } from '../../../lib/api';

/** 只转发安全相关与内容描述头；错误体（JSON）原样返回 */
const PASS = ['Content-Type', 'Content-Disposition', 'X-Content-Type-Options', 'Content-Security-Policy', 'Cache-Control'];

/**
 * 后台改为 cookie 会话转 Bearer 后，A-009 条件 1（api 不读 cookie 防 CSRF）的前提在本层补上：
 * 浏览器带 Sec-Fetch-Site 时只接受同源请求（外站链接 / 跨站 <img> 不能让已登录仲裁员触发预览或写审计的下载）。
 */
export async function proxy(req: Request, path: string): Promise<Response> {
  const site = req.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return Response.json({ code: 'forbidden', message: '仅限后台页面内访问' }, { status: 403 });
  const res = await raw(path).catch(() => null);
  if (!res) return Response.json({ code: 'api_unreachable', message: '后台接口不可达' }, { status: 502 });
  const headers = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  for (const h of PASS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
