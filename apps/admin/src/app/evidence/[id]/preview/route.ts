/**
 * 证据沙箱预览代理：浏览器 <img> 同域请求本路由，服务端带会话转发 api（PNG / 纯文本），原样保留 nosniff / CSP sandbox / no-store。
 * 权限由 api 判定（arbitrator / admin）。
 */
import { proxy } from '../proxy';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = new URL(req.url).searchParams.get('page') ?? '1';
  return proxy(req, `/evidence/${encodeURIComponent(id)}/preview?page=${encodeURIComponent(page)}`);
}
