/**
 * 证据文件类型白名单（上线前置 #21 · D-015 #2）：只接受图片（PNG / JPEG / GIF / WebP）、PDF、纯文本；
 * 以文件头（magic bytes）判定，不信任客户端声明的 Content-Type。
 * 下载（仲裁台）一律 attachment + nosniff + 沙箱 CSP，Content-Type 取判定结果，绝不按原文内联渲染。
 */

export type EvidenceMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf' | 'text/plain';

const EXT: Record<EvidenceMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** 按文件头判定类型；不在白名单 → null */
export function sniffEvidenceType(b: Uint8Array): EvidenceMime | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  // 纯文本：合法 UTF-8 且不含 NUL / 其他 C0 控制符（制表、换行、回车除外）
  try {
    // stream：截断处若切断多字节字符，不视为非法（只检查前 64KB）
    const t = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, 64 * 1024), { stream: true });
    const control = (c: number) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;
    if (![...t].some((ch) => control(ch.charCodeAt(0)))) return 'text/plain';
  } catch {
    /* 非 UTF-8 */
  }
  return null;
}

/** 下载响应头（仲裁台）：attachment + nosniff + 禁止脚本 / 外链；文件名只用证据 id，不回显用户原文件名 */
export function evidenceDownloadHeaders(evidenceId: string, content: Uint8Array): Record<string, string> {
  const mime = sniffEvidenceType(content);
  const type = mime ?? 'application/octet-stream';
  const ext = mime ? EXT[mime] : 'bin';
  return {
    'Content-Type': type === 'text/plain' ? 'text/plain; charset=utf-8' : type,
    'Content-Disposition': `attachment; filename="${evidenceId.replace(/[^A-Za-z0-9_-]/g, '')}.${ext}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  };
}
