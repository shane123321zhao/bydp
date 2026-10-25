/**
 * 导出包下载（隐私与数据页「下载」）：本人、导出类、已完成 → 302 到 7 天预签名链接（链接每次点击现签，不落页面 HTML）。
 * 与公开接口 GET /me/data-requests/{id}/download 同一用例（core getExportDownload）。
 */
import { getExportDownload } from '@bydp/core/admin/data-requests';
import { NextResponse } from 'next/server';
import { auth } from '../../../../../auth';
import { db } from '../../../../../lib/db';
import { evidenceStore } from '../../../../../lib/evidence-store';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const uid = (await auth())?.user?.id;
  if (!uid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const store = evidenceStore();
  const r = store && /^dr_[0-9a-f]{32}$/.test(id) ? await getExportDownload(db(), store, uid, id) : null;
  if (!r) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.redirect(r.url, { status: 302, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}
