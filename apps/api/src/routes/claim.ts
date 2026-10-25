/** POST /offers/{id}/claim（契约 v1.6，需登录）。业务在 @bydp/core/commerce/tracking。 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { ClaimResponse } from '@bydp/core/commerce';
import { CLAIM_REJECT, claimOfferForUser, SELF_EXCLUDED_ERROR, TrackingError } from '@bydp/core/commerce/tracking';
import { ApiError } from '@bydp/core/shared';
import { SelfExcludedError } from '@bydp/core/identity/self-exclusion';
import type { Env } from '../app';
import type { ResolveUser } from '../session';

const err = (description: string) => ({ description, content: { 'application/json': { schema: ApiError } } });
const Unauthorized = z.object({ error: z.literal('unauthorized') });

export function registerClaim(app: OpenAPIHono<Env>, resolveUser: ResolveUser) {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer' });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/offers/{id}/claim',
      tags: ['offers'],
      summary: '领码（登录；记 Click；返回专属码与跟踪链接）',
      security: [{ bearer: [] }],
      request: { params: z.object({ id: z.string().min(1).max(64) }) },
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: ClaimResponse } } },
        400: err('合作方无效'),
        401: { description: '未登录（对外 401 不带 code）', content: { 'application/json': { schema: Unauthorized } } },
        404: err('优惠不存在或已下线（含已过期）'),
        409: err('不可领取：黑名单 / 关联方 / 自我排除期（self_excluded）'),
      },
    }),
    async (c) => {
      const userId = await resolveUser(c);
      if (!userId) return c.json({ error: 'unauthorized' as const }, 401);
      const cc = c.req.header('CF-IPCountry')?.toUpperCase();
      try {
        const r = await claimOfferForUser(c.get('db'), { userId, offerId: c.req.valid('param').id, region: cc && /^[A-Z]{2}$/.test(cc) ? cc : null });
        return c.json(r, 200);
      } catch (e) {
        if (e instanceof SelfExcludedError) return c.json(SELF_EXCLUDED_ERROR, 409);
        const reject = e instanceof TrackingError ? CLAIM_REJECT[e.code] : undefined;
        if (!reject) throw e;
        return c.json(reject.body, reject.status);
      }
    },
  );
}
