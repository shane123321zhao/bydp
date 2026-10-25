/**
 * Cloudflare R2（S3 兼容）最小客户端：AWS SigV4 签名 + path-style 请求，只用 node:crypto，不引 AWS SDK。
 * 用途：证据原文存储（EvidenceStore.put，D-001 M2「R2 存储」）、自检、备份上传。凭据只来自环境变量，本模块不记录。
 */
import { createHash, createHmac } from 'node:crypto';
import type { EvidenceStore } from '../complaint/write';

export type R2Config = { endpoint: string; accessKeyId: string; secretAccessKey: string; region?: string; timeoutMs?: number };
/** 单次请求超时（审核 W3#030 小项）：默认 30 秒；证据上限 20MB，按 ≥ 1MB/s 估 */
export const R2_TIMEOUT_MS = 30_000;

const sha256hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
/** RFC 3986 编码（S3 规则：保留 A-Za-z0-9-_.~，路径里的 / 保留） */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function r2ConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config | null {
  const { R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  if (!/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(endpoint)) throw new Error('R2_ENDPOINT 须为 https://<账户ID>.r2.cloudflarestorage.com');
  return { endpoint: endpoint.replace(/\/$/, ''), accessKeyId, secretAccessKey };
}

/**
 * SigV4 签名（纯函数，便于用 AWS 官方样例验证）。返回需要附加的请求头（含 Authorization）。
 */
export function signV4(p: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now: Date;
}): Record<string, string> {
  const service = p.service ?? 's3';
  const amzDate = p.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...p.headers, host: p.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': p.payloadHash };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = [...p.url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath = p.url.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonicalRequest = [p.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), p.payloadHash].join('\n');
  const scope = `${day}/${p.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${p.secretAccessKey}`, day), p.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/**
 * 预签名 GET URL（SigV4 查询串鉴权，UNSIGNED-PAYLOAD，签名头仅 host）：数据请求导出包下载（契约 /me/data-requests/{id}/download，7 天）。
 * 纯函数，按 AWS 公布的预签名示例向量校验（test/r2.test.ts）。expiresSec 上限 7 天（S3 / R2 规定）。
 */
export function presignGetUrl(p: { url: URL; accessKeyId: string; secretAccessKey: string; region: string; expiresSec: number; now: Date; service?: string }): string {
  if (!Number.isInteger(p.expiresSec) || p.expiresSec < 1 || p.expiresSec > 604_800) throw new Error('预签名有效期须为 1 秒至 7 天');
  const service = p.service ?? 's3';
  const amzDate = p.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${p.region}/${service}/aws4_request`;
  const u = new URL(p.url.toString());
  u.search = '';
  const q: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${p.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(p.expiresSec)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = q
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonicalRequest = ['GET', canonicalPath, canonicalQuery, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${p.secretAccessKey}`, day), p.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return `${u.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export class R2Client {
  constructor(
    private c: R2Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async send(method: 'PUT' | 'GET' | 'HEAD' | 'DELETE', bucket: string, key: string, body?: Uint8Array, contentType?: string | null) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('R2 桶名不合法');
    const url = new URL(`${this.c.endpoint}/${bucket}/${key.split('/').map(enc).join('/')}`);
    const payload = body ?? new Uint8Array();
    const headers = signV4({
      method,
      url,
      headers: contentType ? { 'content-type': contentType } : {},
      payloadHash: sha256hex(payload),
      accessKeyId: this.c.accessKeyId,
      secretAccessKey: this.c.secretAccessKey,
      region: this.c.region ?? 'auto',
      now: new Date(),
    });
    delete (headers as Record<string, string>).host; // fetch 自带 Host
    return this.fetchImpl(url, { method, headers, body: method === 'PUT' ? Buffer.from(payload) : undefined, signal: AbortSignal.timeout(this.c.timeoutMs ?? R2_TIMEOUT_MS) });
  }

  async put(bucket: string, key: string, body: Uint8Array, contentType: string | null = null) {
    const r = await this.send('PUT', bucket, key, body, contentType ?? 'application/octet-stream');
    if (!r.ok) throw new Error(`R2 写入失败：HTTP ${r.status}`);
  }
  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    const r = await this.send('GET', bucket, key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 读取失败：HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async exists(bucket: string, key: string) {
    const r = await this.send('HEAD', bucket, key);
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`R2 查询失败：HTTP ${r.status}`);
    return true;
  }
  /** 预签名下载链接（不发请求） */
  presignGet(bucket: string, key: string, expiresSec: number, now = new Date()): string {
    return presignGetUrl({
      url: new URL(`${this.c.endpoint}/${bucket}/${key.split('/').map(enc).join('/')}`),
      accessKeyId: this.c.accessKeyId,
      secretAccessKey: this.c.secretAccessKey,
      region: this.c.region ?? 'auto',
      expiresSec,
      now,
    });
  }

  async delete(bucket: string, key: string) {
    const r = await this.send('DELETE', bucket, key);
    if (!r.ok && r.status !== 404) throw new Error(`R2 删除失败：HTTP ${r.status}`);
  }
}

/** 证据原文存储（EvidenceStore）：key 由 core addEvidence 生成（evidence/<complaintId>/<evidenceId>） */
export function r2EvidenceStore(client: R2Client, bucket: string): EvidenceStore {
  return { put: (key, content, contentType) => client.put(bucket, key, content, contentType), get: (key) => client.get(bucket, key),
    delete: (key) => client.delete(bucket, key),
    exists: (key) => client.exists(bucket, key),
    presign: (key, expiresSec) => client.presignGet(bucket, key, expiresSec),
  };
}
