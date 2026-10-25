import 'server-only';
import { cache } from 'react';
import { getBrandDetail, getBrandIdentifiers } from '@bydp/core/usecases';
import { db } from './db';

export const brandDetail = cache((slug: string) => getBrandDetail(db(), slug));
export const brandIdentifiers = cache((slug: string) => getBrandIdentifiers(db(), slug));
/** 官网 = 官方主域（Identifier.primary，§7 v1.3）；identifiers 已按 primary 优先排序 */
export async function primaryDomain(slug: string) {
  const ids = (await brandIdentifiers(slug)) ?? [];
  const p = ids.find((i) => i.ownership === 'official' && i.type === 'domain');
  return p?.value ?? null;
}
