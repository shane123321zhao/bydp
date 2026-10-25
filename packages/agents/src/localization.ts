/**
 * 本地化初稿（D-016 第 5 项 · §13 v1.12 ②）：简 → 繁用 OpenCC（大陆 → 台湾，含台湾用语）+ 术语表覆盖；只写 review_item，approve 后 core 落地。
 * 繁体单路径取台湾口径（rules/i18n.md）。英文初稿仅 AGENT_LLM_ENABLED=1 时（本轮未接入，开关关闭即跳过）。
 * 来源：品牌名（name.zhHans 有、zhHant 无）；内容（zh-Hans 行且尚无 zh-Hant 译本）。已有任意状态的同对象同语种提议则跳过。
 */
import { sql } from '@bydp/db';
import { loadGlossary, type GlossaryEntry } from '@bydp/i18n/glossary';
import * as OpenCC from 'opencc-js';
import { proposeReviewItem, type AgentDb } from './db';
import { AGENT_SOURCES, expectedSubject, LocalizationProposal } from './schemas';

const q = <T>(db: AgentDb, s: ReturnType<typeof sql>) => db.execute(s) as unknown as Promise<T[]>;

/**
 * 简 → 台繁转换器；术语表条目优先。opencc-js 的自定义词典作用在转换之后的文本上，
 * 所以词典的键取「OpenCC 对术语简体的直接转换结果」，值取术语表定稿的繁体。
 */
export function makeHansToHant(glossary: GlossaryEntry[] = loadGlossary()): (s: string) => string {
  const base = OpenCC.ConverterFactory(OpenCC.Locale.from.cn!, OpenCC.Locale.to.twp!);
  if (!glossary.length) return base;
  const custom: [string, string][] = glossary.map((g) => [base(g.hans), g.hant]);
  return OpenCC.ConverterFactory(OpenCC.Locale.from.cn!, OpenCC.Locale.to.twp!, [custom]);
}

export async function runLocalization(db: AgentDb, limit = 50, convert = makeHansToHant()): Promise<{ proposed: number; skipped: number }> {
  let proposed = 0;
  let skipped = 0;
  // 逐行校验：不合规的行（超长 / 空白）跳过并记日志，不让一行卡住整批（自检 I5）；不静默截断
  const propose = async (raw: unknown, ref: string) => {
    const r = LocalizationProposal.safeParse(raw);
    if (!r.success) {
      skipped++;
      console.warn(JSON.stringify({ evt: 'agent_localization_skip', ref, issues: r.error.issues.slice(0, 3).map((i) => i.path.join('.') + ':' + i.code) }));
      return;
    }
    if (await proposeReviewItem(db, { kind: 'localization', subject: expectedSubject('localization', r.data)!, proposal: r.data, source: AGENT_SOURCES.localization })) proposed++;
  };
  const brands = await q<{ id: string; name: { zhHans?: string; zhHant?: string } }>(
    db,
    sql`select b."id", b."name" from "brand" b
        where coalesce(b."name"->>'zhHans', '') <> '' and coalesce(b."name"->>'zhHant', '') = ''
          and not exists (select 1 from "review_item" r where r."kind" = 'localization' and r."subject" = 'brand:' || b."id" || ':zh-Hant')
        order by b."id" limit ${limit}`,
  );
  for (const b of brands) {
    const src = b.name.zhHans!;
    await propose({ target: { type: 'brand_name', brandId: b.id }, locale: 'zh-Hant', engine: 'opencc', sourceText: src, title: convert(src) }, `brand:${b.id}`);
  }
  const contents = await q<{ id: string; title: string; body: string | null }>(
    db,
    sql`select c."id", c."title", c."body" from "content" c
        where c."locale" = 'zh-Hans'
          and not exists (select 1 from "content" t where t."sourceId" = c."id" and t."locale" = 'zh-Hant')
          and not exists (select 1 from "review_item" r where r."kind" = 'localization' and r."subject" = 'content:' || c."id" || ':zh-Hant')
        order by c."id" limit ${limit}`,
  );
  for (const c of contents) {
    await propose(
      {
        target: { type: 'content', contentId: c.id },
        locale: 'zh-Hant',
        engine: 'opencc',
        sourceText: [c.title, c.body ?? ''].join('\n\n'),
        title: convert(c.title),
        body: c.body ? convert(c.body) : undefined,
      },
      `content:${c.id}`,
    );
  }
  return { proposed, skipped };
}
