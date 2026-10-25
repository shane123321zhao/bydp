/**
 * 审核台 approve 后的落地动作（D-016 · 架构 §13 v1.12 ①）：Agent 只写 review_item，人工批准后由 core 按 kind 落地，
 * 与决定同一事务、写 audit_log（applied = true + 落地摘要）。proposal 先按 @bydp/agents 的 zod 结构校验，不合法 → 409。
 * - brand_attribute：写 BrandAttribute（source = agent、verified = true、来源 URL / 抓取时刻 / reviewItemId）
 * - site_monitor：offline → identifier.online = false；domain_changed → 新建待查标识（ownership = pending）；terms_changed → 记品牌属性 termsChanged
 * - complaint_screening：只是建议，不改案件状态（applied = false，advisory）
 * - localization：写品牌名对应语种 / 新建或更新对应语种的内容行（仍 noindex 直至 #11）
 */
import { expectedSubject, PROPOSAL_SCHEMAS, type ReviewKind } from '@bydp/agents/schemas';
import { normalizeDomain } from '@bydp/entity-graph';
import { schema, sql, type Db } from '@bydp/db';
import { ComplaintInputError } from '../complaint/write';

type Exec = Pick<Db, 'execute'>;
const q = <T>(db: Exec, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

export type ApplyResult = { applied: boolean; effect: Record<string, unknown> };

export async function applyReviewProposal(tx: Exec, item: { id: string; kind: ReviewKind; subject: string; proposal: unknown }): Promise<ApplyResult> {
  const parsed = PROPOSAL_SCHEMAS[item.kind]?.safeParse(item.proposal);
  if (!parsed?.success) throw new ComplaintInputError('提议内容不符合该类型的结构，不能落地');
  // 审核台显示的对象须与实际落地的对象一致（自检 I2）
  if (expectedSubject(item.kind, item.proposal) !== item.subject) throw new ComplaintInputError('提议的对象与内容不一致，不能落地');
  switch (item.kind) {
    case 'brand_attribute': {
      const p = PROPOSAL_SCHEMAS.brand_attribute.parse(item.proposal);
      const [b] = await q<{ id: string }>(tx, sql`select "id" from ${schema.brands} where "id" = ${p.brandId}`);
      if (!b) throw new ComplaintInputError('提议的品牌不存在');
      // 人工录入的数据不被 Agent 提议静默覆盖（自检 I3）：须先人工处理
      const [cur] = await q<{ source: string }>(tx, sql`select "source" from ${schema.brandAttributes} where "brandId" = ${p.brandId} and "dimension" = ${p.dimension}`);
      if (cur?.source === 'human') throw new ComplaintInputError('该维度已有人工录入的数据，Agent 提议不能覆盖，请人工合并');
      await tx.execute(
        sql`insert into ${schema.brandAttributes} ("brandId", "dimension", "values", "source", "verified", "sourceUrl", "sourceFetchedAt", "reviewItemId")
            values (${p.brandId}, ${p.dimension}, array(select jsonb_array_elements_text(${JSON.stringify(p.values)}::jsonb)), 'agent', true, ${p.sourceUrl}, ${p.fetchedAt}::timestamptz, ${item.id})
            on conflict ("brandId", "dimension") do update set "values" = excluded."values", "source" = 'agent', "verified" = true,
              "sourceUrl" = excluded."sourceUrl", "sourceFetchedAt" = excluded."sourceFetchedAt", "reviewItemId" = excluded."reviewItemId", "updatedAt" = now()`,
      );
      return { applied: true, effect: { brandAttribute: { brandId: p.brandId, dimension: p.dimension, values: p.values.length } } };
    }
    case 'site_monitor': {
      const p = PROPOSAL_SCHEMAS.site_monitor.parse(item.proposal);
      const [idf] = await q<{ id: string; brandId: string | null; value: string }>(tx, sql`select "id", "brandId", "value" from ${schema.identifiers} where "id" = ${p.identifierId}`);
      if (!idf) throw new ComplaintInputError('提议的标识不存在');
      if (p.type === 'offline') {
        await tx.execute(sql`update ${schema.identifiers} set "online" = false, "lastChecked" = current_date, "updatedAt" = now() where "id" = ${idf.id}`);
        return { applied: true, effect: { identifier: idf.id, online: false } };
      }
      if (p.type === 'domain_changed') {
        // 与 /check 同一规范化口径（去 www / 末尾点 / punycode），否则查验时查不到、去重也会漏（自检 I4）
        const host = normalizeDomain(p.newHost);
        if (!host) throw new ComplaintInputError('跳转目标不是有效域名');
        const [exists] = await q<{ id: string }>(tx, sql`select "id" from ${schema.identifiers} where "type" = 'domain' and "value" = ${host}`);
        if (exists) return { applied: true, effect: { identifier: exists.id, created: false } };
        const id = `idf_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
        await tx.execute(
          sql`insert into ${schema.identifiers} ("id", "brandId", "type", "value", "ownership", "firstSeen", "lastChecked", "online", "note")
              values (${id}, ${idf.brandId}, 'domain', ${host}, 'pending', current_date, current_date, true, ${`站点监控：${idf.value} 跳转至此（待人工核验归属）`})`,
        );
        return { applied: true, effect: { identifier: id, created: true, from: idf.id } };
      }
      // terms_changed：记到品牌属性（条款变更时刻 + 新哈希），不改条款内容本身
      if (!idf.brandId) throw new ComplaintInputError('该标识未关联品牌，条款变更无处记录');
      await tx.execute(
        sql`insert into ${schema.brandAttributes} ("brandId", "dimension", "values", "source", "verified", "sourceUrl", "sourceFetchedAt", "reviewItemId")
            values (${idf.brandId}, 'termsChanged', array(select jsonb_array_elements_text(${JSON.stringify([new Date().toISOString().slice(0, 10), p.currentHash])}::jsonb)), 'agent', true, ${p.url}, now(), ${item.id})
            on conflict ("brandId", "dimension") do update set "values" = excluded."values", "source" = 'agent', "verified" = true,
              "sourceUrl" = excluded."sourceUrl", "sourceFetchedAt" = excluded."sourceFetchedAt", "reviewItemId" = excluded."reviewItemId", "updatedAt" = now()`,
      );
      return { applied: true, effect: { brandAttribute: { brandId: idf.brandId, dimension: 'termsChanged' } } };
    }
    case 'complaint_screening':
      // 初筛只是建议：批准表示仲裁员认可建议，案件流转仍走仲裁台（§13 ①「不改案件状态」）
      return { applied: false, effect: { advisory: true } };
    case 'localization': {
      const p = PROPOSAL_SCHEMAS.localization.parse(item.proposal);
      const key = p.locale === 'zh-Hant' ? 'zhHant' : 'en';
      if (p.target.type === 'brand_name') {
        // 提议生成之后若已有人工填写的该语种名称，不覆盖（自检 S5）
        const [cur] = await q<{ v: string | null }>(tx, sql`select "name"->>${key} as "v" from ${schema.brands} where "id" = ${p.target.brandId}`);
        if (cur?.v) throw new ComplaintInputError('该品牌已有此语种的名称，请人工处理');
        const rows = await q<{ id: string }>(
          tx,
          sql`update ${schema.brands} set "name" = "name" || jsonb_build_object(${key}::text, ${p.title}::text), "updatedAt" = now() where "id" = ${p.target.brandId} returning "id"`,
        );
        if (!rows.length) throw new ComplaintInputError('提议的品牌不存在');
        return { applied: true, effect: { brandName: p.target.brandId, locale: p.locale } };
      }
      const [src] = await q<{ id: string; type: string; key: string | null; slug: string | null }>(
        tx,
        sql`select "id", "type", "key", "slug" from ${schema.contents} where "id" = ${p.target.contentId}`,
      );
      if (!src) throw new ComplaintInputError('提议的内容不存在');
      // 同一来源同一语种只保留一行（slug 可能为空，不能依赖 (type, slug, locale) 唯一约束）
      const [existing] = await q<{ id: string }>(tx, sql`select "id" from ${schema.contents} where "sourceId" = ${src.id} and "locale" = ${p.locale} limit 1`);
      const [row] = existing
        ? await q<{ id: string }>(
            tx,
            sql`update ${schema.contents} set "title" = ${p.title}, "body" = ${p.body ?? null}, "updatedAt" = now() where "id" = ${existing.id} returning "id"`,
          )
        : await q<{ id: string }>(
            tx,
            // slug 相同的同语种人工译本已存在时，唯一约束冲突 → 409（自检 S5），由人工合并
            sql`insert into ${schema.contents} ("id", "type", "key", "slug", "locale", "sourceId", "title", "body")
                values (${`ct_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`}, ${src.type}, ${src.key}, ${src.slug}, ${p.locale}, ${src.id}, ${p.title}, ${p.body ?? null})
                on conflict do nothing returning "id"`,
          );
      if (!row) throw new ComplaintInputError('该语种已有同名路径的内容，请人工合并');
      return { applied: true, effect: { content: row!.id, sourceId: src.id, locale: p.locale } };
    }
  }
}
