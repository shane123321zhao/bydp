/** apps/api：Hono + @hono/zod-openapi 薄壳。业务全部在 @bydp/core（ADR-0005 / 0006）。 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { EvidenceStore } from '@bydp/core/complaint/write';
import type { CoreDb } from '@bydp/core/runtime';
import { MemoryRateCounter, type RateCounter } from '@bydp/core/identity/auth';
import { geoBlock, geoBlockedCountries } from './geo';
import { registerCheck } from './routes/check';
import { registerClaim } from './routes/claim';
import { noNotify, noSearchSync, type Notify, type SearchSync } from './notify';
import { registerMe } from './routes/me';
import { POSTBACK_PATH_PREFIX, registerPostback, type PostbackOptions } from './routes/postback';
import { registerRead } from './routes/read';
import { registerAdmin } from './routes/admin';
import { accessConfigFromEnv, accessVerifier, registerAccessCheck } from './access';
import { noSession, type ResolveUser } from './session';
import { gateConfigFromEnv, registerStagingGate, type GateConfig } from './gate';

/** authTime：会话签发时刻（秒），由 ResolveUser 写入；敏感操作（注销）二次验证用 */
export type Env = { Variables: { db: CoreDb; authTime?: number } };

/** counter：共享限流计数（#8 · D-015 #2）；缺省进程内（测试 / 本地），部署由 server.ts 注入 Redis 版 */
/** resolveAdminUser：后台会话（独立子域时只认后台 cookie salt）；缺省同 resolveUser */
export type AppOptions = { resolveUser?: ResolveUser; resolveAdminUser?: ResolveUser; postback?: PostbackOptions; evidenceStore?: EvidenceStore; notify?: Notify; counter?: RateCounter; siteUrl?: string; searchSync?: SearchSync; accessVerify?: (token: string | undefined) => Promise<string | null>; gate?: GateConfig | null };

export function createApp(db: CoreDb, opts: AppOptions = {}) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'bad_request', issues: result.error.issues }, 400);
    },
  });
  const blocked = geoBlockedCountries();
  app.use('*', geoBlock(blocked, [POSTBACK_PATH_PREFIX]));
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });

  const counter = opts.counter ?? new MemoryRateCounter();
  const v1 = new OpenAPIHono<Env>({ defaultHook: app.defaultHook });
  registerCheck(v1, { trustProxy: opts.postback?.trustProxy });
  registerRead(v1);
  registerClaim(v1, opts.resolveUser ?? noSession);
  registerMe(v1, opts.resolveUser ?? noSession, opts.evidenceStore, opts.notify ?? noNotify, counter);
  // 文档挂在 v1 子应用：路径相对 /v1（与 docs/design/api-contract.yaml 的 servers + paths 布局一致）
  v1.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'BYDP 博弈点评 · Public API', version: '0.1.0' },
    servers: [{ url: '/v1' }],
  });
  // 运营商回传：不进公开文档（契约另行定义）
  registerPostback(app, { geoBlocked: blocked, counter, ...opts.postback });
  // 后台（admin 契约 v0.2）：/admin/v1，不进公开文档
  registerAdmin(app, opts.resolveAdminUser ?? opts.resolveUser ?? noSession, { notify: opts.notify ?? noNotify, evidenceStore: opts.evidenceStore, trustProxy: opts.postback?.trustProxy, siteUrl: opts.siteUrl ?? process.env.SITE_URL ?? null, searchSync: opts.searchSync ?? noSearchSync });
  // D-020 #30：后台子域 Caddy forward_auth 校验 Cloudflare Access JWT（内网路径，主站不转发）；未配置即全部拒绝
  registerAccessCheck(app as never, opts.accessVerify ?? accessVerifier(accessConfigFromEnv()));
  // W2#010：测试站 Cookie 门禁（内网路径，由 Caddy 改写进来）；正式环境 / 未配置不注册
  registerStagingGate(app as never, opts.gate !== undefined ? opts.gate : gateConfigFromEnv(), counter, { trustProxy: opts.postback?.trustProxy });
  app.route('/v1', v1);
  return app;
}
