import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { checkIdentifier } from '@bydp/core/trust/check';
import { CheckQuery, CheckResult } from '@bydp/core/trust';
import { recordCandidateQuery } from '@bydp/core/trust/candidate-queries';
import { identityHmacKeyFromEnv } from '@bydp/core/identity/pii';
import type { Env } from '../app';

const route = createRoute({
  method: 'get',
  path: '/check',
  tags: ['check'],
  summary: '查验任意标识',
  request: { query: CheckQuery },
  responses: {
    200: { description: '判定结果', content: { 'application/json': { schema: CheckResult } } },
    400: { description: '参数错误' },
  },
});

export function registerCheck(app: OpenAPIHono<Env>, opts: { trustProxy?: boolean } = {}) {
  app.openapi(route, async (c) => {
    const { q } = c.req.valid('query');
    const r = await checkIdentifier(c.get('db'), q);
    // D-016 第 6 项：未收录查询计入 Candidate（同 IP 网段一天只计 1 次）；密钥未配置时不计（本地 / 测试）
    if (r.verdict === 'unknown' && r.normalized?.type && r.normalized.value && process.env.IDENTITY_HMAC_KEY) {
      const ip = opts.trustProxy ? (c.req.header('CF-Connecting-IP') ?? null) : null;
      // 计数失败不影响查验结果
      try {
        await recordCandidateQuery(c.get('db'), { type: r.normalized.type, value: r.normalized.value }, { ip, deviceId: null, userAgent: c.req.header('User-Agent') ?? null }, identityHmacKeyFromEnv());
      } catch (e) {
        console.error(JSON.stringify({ evt: 'candidate_query_record_failed', error: (e as Error).message.slice(0, 120) }));
      }
    }
    return c.json(r, 200);
  });
}
