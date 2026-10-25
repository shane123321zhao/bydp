/** R2 / SigV4：用 AWS 官方文档的已知样例验证签名；客户端用假 fetch，不连真实 R2 */
import { describe, expect, it } from 'vitest';
import { presignGetUrl, R2Client, r2ConfigFromEnv, signV4 } from '../src/storage/r2';

describe('signV4（AWS 官方样例：GET /test.txt，Range: bytes=0-9）', () => {
  it('签名与文档一致', () => {
    const h = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('R2Client（假 fetch）', () => {
  const cfg = { endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', accessKeyId: 'AK', secretAccessKey: 'SK' };
  it('path-style URL、签名头、PUT 带正文；非 2xx 抛错且不回显凭据', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: URL, init: RequestInit) => (calls.push({ url: String(url), init }), new Response('', { status: 200 }))) as unknown as typeof fetch;
    await new R2Client(cfg, ok).put('bydp-evidence', 'evidence/cp_1/ev 1', new Uint8Array([1, 2]), 'image/png');
    expect(calls[0]!.url).toBe('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/bydp-evidence/evidence/cp_1/ev%201');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const bad = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    const err = await new R2Client(cfg, bad).put('bydp-evidence', 'k', new Uint8Array([1])).catch((e: Error) => e.message);
    expect(err).toBe('R2 写入失败：HTTP 403');
    await expect(new R2Client(cfg, ok).put('Bad_Bucket', 'k', new Uint8Array())).rejects.toThrow(/桶名/);
  });
  it('请求带超时（AbortSignal）；超时即失败', async () => {
    let signal: AbortSignal | undefined;
    const hang = (async (_u: URL, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
    }) as unknown as typeof fetch;
    const err = await new R2Client({ ...cfg, timeoutMs: 50 }, hang).get('bydp-evidence', 'k').catch((e: Error) => e.name);
    expect(signal).toBeDefined();
    expect(err).toBe('TimeoutError');
  });

  it('配置：三项缺一返回 null；端点须为 https', () => {
    expect(r2ConfigFromEnv({})).toBeNull();
    expect(() => r2ConfigFromEnv({ R2_ENDPOINT: 'http://x', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' })).toThrow(/https/);
  });
});

describe('presignGetUrl（导出包下载）', () => {
  it('AWS 公布的预签名示例向量（examplebucket / test.txt / 86400 秒）', () => {
    const url = presignGetUrl({
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      expiresSec: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
  it('有效期上限 7 天', () => {
    const base = { url: new URL('https://x.r2.cloudflarestorage.com/b/k'), accessKeyId: 'a', secretAccessKey: 's', region: 'auto', now: new Date() };
    expect(() => presignGetUrl({ ...base, expiresSec: 604_801 })).toThrow();
    expect(presignGetUrl({ ...base, expiresSec: 604_800 })).toContain('X-Amz-Expires=604800');
  });
});
