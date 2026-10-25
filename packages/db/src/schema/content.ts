// 内容域（架构 v1.2 §7）：Content · Glossary · SimResult
import { index, integer, jsonb, numeric, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_shared';

export const contentType = pgEnum('content_type', ['guide', 'lab', 'news', 'advice']);
export const contentLocale = pgEnum('content_locale', ['zh-Hans', 'zh-Hant', 'en']);

/** 多语言内容：简体为源（sourceId = null），繁 / 英为译本（sourceId → 简体条目）；advice 以 verdict 为 key */
export const contents = pgTable(
  'content',
  {
    id: pk('ct'),
    type: contentType('type').notNull(),
    key: text('key'),
    slug: text('slug'),
    locale: contentLocale('locale').notNull().default('zh-Hans'),
    sourceId: text('sourceId'),
    title: text('title').notNull(),
    body: text('body'),
    publishedAt: tsz('publishedAt'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('content_type_slug_locale_uq').on(t.type, t.slug, t.locale),
    index('content_type_key_idx').on(t.type, t.key, t.locale),
  ],
);

/** 术语表（DB 镜像；代码可消费真源在 packages/i18n/glossary/） */
export const glossary = pgTable('glossary', {
  id: pk('gl'),
  zhHans: text('zhHans').notNull().unique(),
  zhHant: text('zhHant'),
  /** 港澳口径词：只作 Meilisearch 搜索同义词（ADR-0004） */
  zhHantHkSynonyms: text('zhHantHkSynonyms').array(),
  en: text('en'),
  note: text('note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 策略实验室蒙特卡洛结果 */
export const simResults = pgTable('sim_result', {
  id: pk('sim'),
  strategy: text('strategy').notNull(),
  params: jsonb('params'),
  runs: integer('runs').notNull(),
  bustProbability: numeric('bustProbability', { precision: 5, scale: 4, mode: 'number' }).notNull(),
  expectedValue: numeric('expectedValue', { precision: 18, scale: 4, mode: 'number' }).notNull(),
  computedAt: tsz('computedAt').notNull().defaultNow(),
});
