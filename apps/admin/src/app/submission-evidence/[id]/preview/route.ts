/** D-024 出款凭证截图沙箱预览代理（同证据预览：服务端转位图，不下发原文件；权限由 api 判定 arbitrator / admin） */
import { proxy } from '../../../evidence/[id]/proxy';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = new URL(req.url).searchParams.get('page') ?? '1';
  return proxy(req, `/submission-evidence/${encodeURIComponent(id)}/preview?page=${encodeURIComponent(page)}`);
}
