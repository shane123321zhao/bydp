/**
 * D-034：把当前路径（不含 basePath /admin）放进请求头，供根布局判断「登录页无需会话即可渲染」；其他页面的会话校验不变。
 * 客户端自带的同名头一律被覆盖，不能借此绕过布局校验（布局只对 /login 放行，真正的权限仍由各接口校验）。
 */
import { NextResponse, type NextRequest } from 'next/server';

export const ADMIN_PATH_HEADER = 'x-bydp-admin-path';

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set(ADMIN_PATH_HEADER, req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!_next/|favicon).*)'] };
