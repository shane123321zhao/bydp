/**
 * 证据沙箱预览渲染（admin 契约 v0.2 Q2 · 审核 D-015 #2 提醒）：仲裁员在页面内看位图，不下载原文件到本机打开。
 * - 图片：sharp 重编码为 PNG（去 EXIF / 元数据，按方向旋正，宽 ≤ 2000px，像素上限防解压炸弹）；
 * - PDF：poppler `pdftoppm` 子进程渲染单页为 PNG（不执行内嵌脚本），10 秒超时即杀进程；再经 sharp 规整；
 * - 纯文本：原样以 text/plain 返回（nosniff，浏览器不会当网页解析）。
 * 类型以文件头判定（core sniffEvidenceType），不信任上传时的声明。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffEvidenceType } from '@bydp/core/complaint/evidence-type';
import sharp from 'sharp';

export const PREVIEW_MAX_WIDTH = 2000;
export const PDF_TIMEOUT_MS = 10_000;

export class PreviewUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewUnavailableError';
  }
}
export class PreviewPageNotFoundError extends Error {
  constructor() {
    super('该页不存在');
    this.name = 'PreviewPageNotFoundError';
  }
}

const toPng = (b: Uint8Array) =>
  sharp(b, { limitInputPixels: 60_000_000 }).rotate().resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true }).png().toBuffer();

function runPdftoppm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString().slice(0, 500)));
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new PreviewUnavailableError('PDF 渲染超时'));
    }, PDF_TIMEOUT_MS);
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      reject(new PreviewUnavailableError(e.code === 'ENOENT' ? 'PDF 渲染组件（poppler）未安装' : 'PDF 渲染失败'));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      // 请求页超出文档页数：pdftoppm 退出 99 并提示 "Wrong page range given" → 404，而非服务不可用
      else if (/Wrong page range/i.test(stderr)) reject(new PreviewPageNotFoundError());
      else reject(new PreviewUnavailableError(`PDF 渲染失败（${code}）${stderr ? '：' + stderr.split('\n')[0] : ''}`));
    });
  });
}

async function pdfPage(content: Uint8Array, page: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'bydp-pv-'));
  try {
    const src = join(dir, 'in.pdf');
    await writeFile(src, content);
    await runPdftoppm(['-png', '-f', String(page), '-l', String(page), '-r', '110', '-scale-to-x', String(PREVIEW_MAX_WIDTH), '-scale-to-y', '-1', '-singlefile', src, join(dir, 'out')]);
    const png = await readFile(join(dir, 'out.png')).catch(() => null);
    if (!png) throw new PreviewPageNotFoundError();
    return toPng(png);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 渲染第 page 页（图片 / 文本只有第 1 页） */
export async function renderPreview(content: Uint8Array, page: number): Promise<{ body: Uint8Array; contentType: string; cacheable: boolean }> {
  const mime = sniffEvidenceType(content);
  if (!mime) throw new PreviewUnavailableError('文件类型不在白名单，不提供预览');
  if (mime === 'application/pdf') return { body: await pdfPage(content, page), contentType: 'image/png', cacheable: true };
  if (page !== 1) throw new PreviewPageNotFoundError();
  if (mime === 'text/plain') return { body: content.subarray(0, 64 * 1024), contentType: 'text/plain; charset=utf-8', cacheable: false };
  return { body: await toPng(content), contentType: 'image/png', cacheable: true };
}
