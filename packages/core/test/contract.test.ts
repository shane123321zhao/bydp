/**
 * core zod schema ↔ docs/design/api-contract.yaml 对齐校验：
 * 每个组件的属性键集合、required 集合、枚举值必须一致（接口以 api-contract 为准）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import * as shared from '../src/shared/index';
import * as trust from '../src/trust/index';
import * as complaint from '../src/complaint/index';
import * as commerce from '../src/commerce/index';
import * as identity from '../src/identity/index';
import * as api from '../src/api/index';

type J = Record<string, unknown>;
const contract = parse(readFileSync(join(import.meta.dirname, '../../../docs/design/api-contract.yaml'), 'utf8')) as J;
const components = (contract.components as J).schemas as Record<string, J>;

/** 展开 allOf / $ref，得到 { properties, required, enum } */
function flatten(s: J): { props: Set<string>; required: Set<string>; enumVals?: string[] } {
  if (s.$ref) return flatten(components[String(s.$ref).split('/').pop()!]!);
  if (s.allOf) {
    const out = { props: new Set<string>(), required: new Set<string>() };
    for (const part of s.allOf as J[]) {
      const f = flatten(part);
      f.props.forEach((p) => out.props.add(p));
      f.required.forEach((r) => out.required.add(r));
    }
    return out;
  }
  return {
    props: new Set(Object.keys((s.properties as J) ?? {})),
    required: new Set((s.required as string[]) ?? []),
    enumVals: s.enum as string[] | undefined,
  };
}

function zodShape(schema: z.ZodType) {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as J;
  return {
    props: new Set(Object.keys((js.properties as J) ?? {})),
    required: new Set((js.required as string[]) ?? []),
    enumVals: js.enum as string[] | undefined,
  };
}

/** 规范化后的结构：递归比较对象属性、required、数组元素、枚举、nullable */
type Norm = { nullable: boolean; enum?: string[]; props?: Record<string, Norm>; required?: string[]; items?: Norm };

function normContract(s: J | undefined, nullable = false): Norm {
  if (!s) return { nullable };
  // OpenAPI 3.1 可空写法：type: [x, 'null'] 或 oneOf/anyOf: [x, { type: 'null' }]（3.0 的 nullable: true 仍兼容）
  if (Array.isArray(s.type) && s.type.includes('null')) {
    const rest = (s.type as string[]).filter((t) => t !== 'null');
    return normContract({ ...s, type: rest.length === 1 ? rest[0] : rest }, true);
  }
  const alt = (s.oneOf ?? s.anyOf) as J[] | undefined;
  if (alt) {
    const nonNull = alt.filter((a) => a.type !== 'null');
    if (nonNull.length === 1) return normContract(nonNull[0], nullable || nonNull.length < alt.length);
  }
  if (s.$ref) return normContract(components[String(s.$ref).split('/').pop()!], nullable || s.nullable === true);
  const isNull = nullable || s.nullable === true;
  if (s.allOf) {
    const parts = (s.allOf as J[]).map((p) => normContract(p));
    const props = Object.assign({}, ...parts.map((p) => p.props ?? {})) as Record<string, Norm>;
    return { nullable: isNull, props, required: [...new Set(parts.flatMap((p) => p.required ?? []))].sort() };
  }
  if (s.type === 'array') return { nullable: isNull, items: normContract(s.items as J) };
  if (s.properties) {
    const props = Object.fromEntries(Object.entries(s.properties as J).map(([k, v]) => [k, normContract(v as J)]));
    return { nullable: isNull, props, required: [...((s.required as string[]) ?? [])].sort() };
  }
  return { nullable: isNull, ...(s.enum ? { enum: s.enum as string[] } : {}) };
}

function normZod(s: J | undefined, nullable = false): Norm {
  if (!s) return { nullable };
  if (Array.isArray(s.type) && s.type.includes('null')) {
    const rest = (s.type as string[]).filter((t) => t !== 'null');
    return normZod({ ...s, type: rest.length === 1 ? rest[0] : rest }, true);
  }
  const alt = (s.anyOf ?? s.oneOf) as J[] | undefined;
  if (alt) {
    const nonNull = alt.filter((a) => a.type !== 'null');
    if (nonNull.length === 1) return normZod(nonNull[0], nullable || nonNull.length < alt.length);
  }
  if (s.type === 'array') return { nullable, items: normZod(s.items as J) };
  if (s.properties) {
    const props = Object.fromEntries(Object.entries(s.properties as J).map(([k, v]) => [k, normZod(v as J)]));
    return { nullable, props, required: [...((s.required as string[]) ?? [])].sort() };
  }
  return { nullable, ...(s.enum ? { enum: s.enum as string[] } : {}) };
}

/** 契约里写成自由对象（type: object 无 properties / additionalProperties）的位置，zod 侧亦为开放对象：不下钻 */
function diff(want: Norm, got: Norm, path: string, out: string[]) {
  if (want.nullable !== got.nullable) out.push(`${path}: nullable 契约=${want.nullable} zod=${got.nullable}`);
  if (want.enum && JSON.stringify(want.enum) !== JSON.stringify(got.enum)) out.push(`${path}: enum 契约=${want.enum} zod=${got.enum}`);
  if (want.items) diff(want.items, got.items ?? { nullable: false }, `${path}[]`, out);
  if (want.props) {
    const w = Object.keys(want.props).sort();
    const g = Object.keys(got.props ?? {}).sort();
    if (JSON.stringify(w) !== JSON.stringify(g)) out.push(`${path}: keys 契约=${w} zod=${g}`);
    if (JSON.stringify(want.required ?? []) !== JSON.stringify(got.required ?? [])) out.push(`${path}: required 契约=${want.required} zod=${got.required}`);
    for (const k of w) if (got.props?.[k]) diff(want.props[k]!, got.props[k]!, `${path}.${k}`, out);
  }
}

const MAP: Record<string, z.ZodType> = {
  Error: shared.ApiError,
  LocalizedName: shared.LocalizedName,
  BrandStatus: shared.BrandStatus,
  Ownership: shared.Ownership,
  Confidence: shared.Confidence,
  Verdict: shared.Verdict,
  Fact: shared.Fact,
  TimelineEvent: shared.TimelineEvent,
  BrandCard: trust.BrandCard,
  ScoreBrief: trust.ScoreBrief,
  ScoreSnapshot: trust.ScoreSnapshot,
  License: trust.License,
  Identifier: trust.Identifier,
  EntityLinkRow: trust.EntityLinkRow,
  CheckResult: trust.CheckResult,
  WithdrawalStats: trust.WithdrawalStats,
  ListPage: trust.ListPage,
  ComplaintPublic: complaint.ComplaintPublic,
  ComplaintPage: complaint.ComplaintPage,
  CasePublic: complaint.CasePublic,
  ComplaintCreate: complaint.ComplaintCreate,
  ComplaintMine: complaint.ComplaintMine,
  Evidence: complaint.Evidence,
  Offer: commerce.Offer,
  OfferStats: commerce.OfferStats,
  MeBrief: identity.MeBrief,
  Binding: identity.Binding,
  MePayload: identity.MePayload,
  Preferences: identity.Preferences,
  BrandDetail: api.BrandDetail,
  HomePayload: api.HomePayload,
};

describe('api-contract.yaml ↔ @bydp/core zod', () => {
  it('每个契约组件都有对应 zod schema', () => {
    expect(Object.keys(components).filter((k) => !(k in MAP))).toEqual([]);
  });

  for (const [name, schema] of Object.entries(MAP)) {
    it(name, () => {
      const want = flatten(components[name]!);
      const got = zodShape(schema);
      expect([...got.props].sort()).toEqual([...want.props].sort());
      expect([...got.required].sort()).toEqual([...want.required].sort());
      if (want.enumVals) expect(got.enumVals).toEqual(want.enumVals);
    });
    it(`${name}（递归：嵌套属性 / 数组元素 / 枚举 / nullable）`, () => {
      const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as J;
      const out: string[] = [];
      diff(normContract(components[name]), normZod(js), name, out);
      expect(out).toEqual([]);
    });
  }
});
