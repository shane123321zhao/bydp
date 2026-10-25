/** 证据原文下载代理（例外场景；api 写 audit_log，响应头 attachment / nosniff / CSP sandbox 原样转发） */
import { proxy } from '../proxy';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxy(req, `/evidence/${encodeURIComponent(id)}/download`);
}
