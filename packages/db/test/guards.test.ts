/**
 * DB 守卫集成测试（需已迁移 + 已执行 sql/*.sql + 已 seed 的库；DATABASE_URL 用 owner 连接）。
 * 未设 DATABASE_URL 时跳过。验证：只追加表、Evidence 哈希锁、boundAt 不可改、bydp_scoring_ro 白名单。
 */
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (process.env.BYDP_CI === '1' && !url) throw new Error('CI 必须提供 DATABASE_URL：DB 通用断言不得跳过');
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
afterAll(async () => sql?.end());

const ROLLBACK = new Error('rollback');
/** 在事务内执行（可选 SET ROLE），总是回滚；返回错误信息或 null */
async function attempt(stmts: string[], role?: string): Promise<string | null> {
  try {
    await sql!.begin(async (tx) => {
      if (role) await tx.unsafe(`SET LOCAL ROLE ${role}`);
      for (const s of stmts) await tx.unsafe(s);
      throw ROLLBACK;
    });
    return null;
  } catch (e) {
    return e === ROLLBACK ? null : (e as Error).message;
  }
}

const HASH = 'a'.repeat(64);
/** A-011：形状合法的密文（守卫只校验形状；解密由 core 测试覆盖） */
const ENC = 'v1:AAA=:BBB=:CCC=';
const insertEvidence = `INSERT INTO "evidence" ("id","complaintId","type","sha256") VALUES ('ev_t','cp_001','screenshot','${HASH}')`;

describe.skipIf(!url)('只追加 / 不可改', () => {
  it('status_history 禁止 UPDATE / DELETE / TRUNCATE（owner 也不行）', async () => {
    expect(await attempt([`UPDATE "status_history" SET "reason" = 'x'`])).toMatch(/append-only/);
    expect(await attempt([`DELETE FROM "status_history"`])).toMatch(/append-only/);
    expect(await attempt([`TRUNCATE "status_history"`])).toMatch(/append-only/);
  });

  it('audit_log 禁止 UPDATE / DELETE', async () => {
    const ins = `INSERT INTO "audit_log" ("actorId","action","targetType") VALUES ('u','t','brand')`;
    expect(await attempt([ins, `UPDATE "audit_log" SET "action" = 'y'`])).toMatch(/append-only/);
    expect(await attempt([ins, `DELETE FROM "audit_log"`])).toMatch(/append-only/);
  });

  it('evidence：哈希不可改、不可删；原文可脱敏且不可逆', async () => {
    expect(await attempt([insertEvidence, `UPDATE "evidence" SET "sha256" = '${'b'.repeat(64)}' WHERE "id"='ev_t'`])).toMatch(/append-only/);
    expect(await attempt([insertEvidence, `DELETE FROM "evidence" WHERE "id"='ev_t'`])).toMatch(/append-only/);
    expect(await attempt([insertEvidence, `UPDATE "evidence" SET "redacted" = true, "storageKey" = null, "redactedAt" = now() WHERE "id"='ev_t'`])).toBeNull();
    expect(
      await attempt([insertEvidence, `UPDATE "evidence" SET "redacted" = true WHERE "id"='ev_t'`, `UPDATE "evidence" SET "redacted" = false WHERE "id"='ev_t'`]),
    ).toMatch(/irreversible/);
    expect(await attempt([`INSERT INTO "evidence" ("id","complaintId","type","sha256") VALUES ('ev_x','cp_001','screenshot','3f9a…c21e')`])).toMatch(
      /evidence_sha256_hex/,
    );
  });

  it('证据原文删除后不可恢复指向；脱敏后不可改指向', async () => {
    const del = `UPDATE "evidence" SET "deletedAt" = now(), "storageKey" = null WHERE "id"='ev_t'`;
    expect(await attempt([insertEvidence, del])).toBeNull();
    expect(await attempt([insertEvidence, del, `UPDATE "evidence" SET "storageKey" = 's3://orig' WHERE "id"='ev_t'`])).toMatch(/irreversible/);
    expect(await attempt([insertEvidence, `UPDATE "evidence" SET "deletedAt" = now() , "storageKey" = 's3://x' WHERE "id"='ev_t'`])).toMatch(/must not reference/);
    const withObj = `UPDATE "evidence" SET "storageKey" = 's3://orig' WHERE "id"='ev_t'`;
    const redact = `UPDATE "evidence" SET "redacted" = true, "storageKey" = 's3://redacted' WHERE "id"='ev_t'`;
    expect(await attempt([insertEvidence, withObj, redact, `UPDATE "evidence" SET "storageKey" = 's3://orig' WHERE "id"='ev_t'`])).toMatch(/re-pointed/);
  });

  it('服务端时间戳：bydp_app 插入时传入的历史时间被 DB 时间覆盖', async () => {
    const r = await sql!.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE bydp_app');
      await tx.unsafe(`SET LOCAL bydp.allow_backfill = 'on'`); // 非 owner：开关无效
      const [b] = await tx.unsafe<{ boundAt: Date }[]>(
        `INSERT INTO "user_brand_binding" ("id","userId","brandId","operatorAccountIdEnc","operatorAccountIdMasked","operatorAccountIdHash","source","boundAt")
         VALUES ('ubb_t','u_102','br_winner','${ENC}','X***','${HASH}','manual','2020-01-01') RETURNING "boundAt"`,
      );
      const [h] = await tx.unsafe<{ at: Date }[]>(
        `INSERT INTO "status_history" ("brandId","to","actor","at") VALUES ('br_winner','watch','t','2020-01-01') RETURNING "at"`,
      );
      const [now] = await tx.unsafe<{ now: Date }[]>('SELECT now()');
      throw Object.assign(new Error('rb'), { rows: [b!.boundAt, h!.at, now!.now] });
    }).catch((e: { rows: Date[] }) => e.rows);
    expect(r[0]!.getTime()).toBe(r[2]!.getTime());
    expect(r[1]!.getTime()).toBe(r[2]!.getTime());
  });

  it('user_brand_binding.boundAt 不可改；核验等级可升级', async () => {
    expect(await attempt([`UPDATE "user_brand_binding" SET "boundAt" = now() WHERE "id"='ubb_001'`])).toMatch(/immutable/);
    expect(await attempt([`UPDATE "user_brand_binding" SET "verificationLevel"='operator_confirmed' WHERE "id"='ubb_002'`])).toBeNull();
    // 赔付资格只认回传确认 / 运营商确认
    expect(await attempt([`UPDATE "user_brand_binding" SET "compensationEligible"=true WHERE "id"='ubb_002'`])).toMatch(
      /binding_eligibility_level/,
    );
  });

  it('M1：绑定身份列不可改（运营商账号 / 来源），owner 与 bydp_app 均拒', async () => {
    // A-012 起无明文列：账号身份 = 密文 + 盲索引，改密文同样被拒
    const acct = `UPDATE "user_brand_binding" SET "operatorAccountIdEnc"='v1:VVV=:BBB=:CCC=' WHERE "id"='ubb_001'`;
    expect(await attempt([acct], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([acct])).toMatch(/immutable/);
    expect(await attempt([`UPDATE "user_brand_binding" SET "source"='manual' WHERE "id"='ubb_001'`])).toMatch(/immutable/);
  });

  it('D-002：绑定盲索引唯一且不可改', async () => {
    const [b] = await sql!<{ h: string; brandId: string }[]>`select "operatorAccountIdHash" as h, "brandId" from "user_brand_binding" where id = 'ubb_001'`;
    const dup = `INSERT INTO "user_brand_binding" ("id","userId","brandId","operatorAccountIdEnc","operatorAccountIdMasked","operatorAccountIdHash","source")
                 VALUES ('ubb_dup','u_233','${b!.brandId}','${ENC}','o***t','${b!.h}','manual')`;
    expect(await attempt([dup], 'bydp_app')).toMatch(/binding_brand_account_hash_uq/);
    // 同 hash 不同品牌允许
    expect(await attempt([dup.replace(`'${b!.brandId}'`, `'br_royal'`)], 'bydp_app')).toBeNull();
    expect(await attempt([`UPDATE "user_brand_binding" SET "operatorAccountIdHash"='${HASH}' WHERE "id"='ubb_001'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`UPDATE "user_brand_binding" SET "operatorAccountIdHash"='${HASH}' WHERE "id"='ubb_001'`])).toMatch(/immutable/);
    expect(await attempt([dup.replace(`'${b!.h}'`, `'not-hex'`).replace(`'${b!.brandId}'`, `'br_royal'`)], 'bydp_app')).toMatch(/binding_account_hash_hex/);
  });

  it('D-002：exposure_complaint 外键、不可删改', async () => {
    expect(await attempt([`INSERT INTO "exposure_complaint" ("exposureId","complaintId") VALUES ('ex_001','cp_nope')`], 'bydp_app')).toMatch(/foreign key/);
    expect(await attempt([`INSERT INTO "exposure_complaint" ("exposureId","complaintId") VALUES ('ex_nope','cp_001')`], 'bydp_app')).toMatch(/foreign key/);
    expect(await attempt([`INSERT INTO "exposure_complaint" ("exposureId","complaintId") VALUES ('ex_003','cp_001')`], 'bydp_app')).toBeNull();
    expect(await attempt([`DELETE FROM "exposure_complaint"`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`UPDATE "exposure_complaint" SET "complaintId"='cp_002'`], 'bydp_app')).toMatch(/permission denied/);
    const [n] = await sql!<{ n: number }[]>`select count(*)::int as n from "exposure_complaint" where "exposureId" = 'ex_001'`;
    expect(n!.n).toBe(1); // Exposure.complaintIds.length 的新来源
  });

  it('D-002：物理表名 app_user（无 user 表），user_role 外键到 app_user / role', async () => {
    const [u] = await sql!<{ n: number }[]>`select count(*)::int as n from pg_tables where schemaname='public' and tablename='user'`;
    expect(u!.n).toBe(0);
    // 0012（A-015）起 role 四行参照为种子：枚举内的角色都有参照行，外键反例只剩用户侧
    expect(await attempt([`INSERT INTO "user_role" ("userId","roleKey") VALUES ('u_102','arbitrator')`], 'bydp_app')).toBeNull();
    expect(await attempt([`INSERT INTO "user_role" ("userId","roleKey") VALUES ('u_nope','arbitrator')`], 'bydp_app')).toMatch(/foreign key/);
    expect(await attempt([`DELETE FROM "role" WHERE "key"='admin'`, `INSERT INTO "user_role" ("userId","roleKey") VALUES ('u_102','admin')`])).toMatch(/foreign key/);
  });

  it('D-002：identifier.primary 每品牌 ≤ 1 且必须是官方域名', async () => {
    expect(await attempt([`UPDATE "identifier" SET "primary"=true WHERE "id"='idf_002'`], 'bydp_app')).toMatch(/identifier_primary_is_official_domain/);
    expect(
      await attempt([`INSERT INTO "identifier" ("id","brandId","type","value","ownership","primary") VALUES ('idf_t','br_jinlong','domain','jl2.com','official',true)`], 'bydp_app'),
    ).toMatch(/identifier_primary_per_brand_uq/);
    const [p] = await sql!<{ n: number }[]>`select count(*)::int as n from "identifier" where "primary"`;
    expect(p!.n).toBe(4);
  });

  it('D-002：complaint.eventDate / description NOT NULL', async () => {
    expect(
      await attempt([`INSERT INTO "complaint" ("id","brandId","userId","category","title","amountUsdt","description") VALUES ('cp_t','br_winner','u_102','delay','t',1,'d')`], 'bydp_app'),
    ).toMatch(/eventDate/);
  });

  it('M2：所有含 createdAt 的表 + conversion.receivedAt 都有服务端时间戳 INSERT 触发器', async () => {
    const missing = await sql!<{ t: string }[]>`
      select c.table_name as t from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'createdAt'
        and not exists (select 1 from pg_trigger g join pg_class k on k.oid = g.tgrelid
                        where k.relname = c.table_name and g.tgname = c.table_name || '_created_at_server_ts')
      order by 1`;
    expect(missing.map((r) => r.t)).toEqual([]);
    const [conv] = await sql!<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'conversion_received_at_server_ts'`;
    expect(conv!.n).toBe(1);
  });

  it('M2b：所有含 createdAt 的表 + conversion.receivedAt 同时有 UPDATE 不可改触发器', async () => {
    const missing = await sql!<{ t: string }[]>`
      select c.table_name as t from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'createdAt'
        and not exists (select 1 from pg_trigger g join pg_class k on k.oid = g.tgrelid
                        where k.relname = c.table_name and g.tgname = c.table_name || '_created_at_immutable')
      order by 1`;
    expect(missing.map((r) => r.t)).toEqual([]);
    const [conv] = await sql!<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'conversion_received_at_immutable'`;
    expect(conv!.n).toBe(1);
  });

  it('M2b：bydp_app 事后改 complaint.createdAt / click.createdAt / conversion.receivedAt 被拒', async () => {
    expect(await attempt([`UPDATE "complaint" SET "createdAt"='2020-01-01' WHERE "id"='cp_001'`], 'bydp_app')).toMatch(/immutable/);
    // 0005 起 click / conversion 整表只追加（A-007 F2 / G2）：业务账号在权限层即被拒，owner 被触发器拒
    const click = `INSERT INTO "click" ("id","brandId") VALUES ('clk_t','br_winner')`;
    expect(await attempt([click, `UPDATE "click" SET "createdAt"='2020-01-01' WHERE "id"='clk_t'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([click, `UPDATE "click" SET "createdAt"='2020-01-01' WHERE "id"='clk_t'`])).toMatch(/immutable|append-only/);
    const conv = `INSERT INTO "conversion" ("id","brandId","externalEventId","operatorAccountIdHash","event") VALUES ('cv_t','br_winner','e_t','${HASH}','register')`;
    expect(await attempt([conv, `UPDATE "conversion" SET "receivedAt"='2020-01-01' WHERE "id"='cv_t'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([conv, `UPDATE "conversion" SET "receivedAt"='2020-01-01' WHERE "id"='cv_t'`])).toMatch(/immutable|append-only/);
    // 非时间列仍可正常更新
    expect(await attempt([`UPDATE "complaint" SET "resolution"='x' WHERE "id"='cp_001'`], 'bydp_app')).toBeNull();
  });

  it('brand.statusSince 不可单独改；状态变更时由服务端置为当天', async () => {
    expect(await attempt([`UPDATE "brand" SET "statusSince"='2010-01-01' WHERE "id"='br_winner'`], 'bydp_app')).toMatch(/statusSince/);
    const r = await sql!
      .begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE bydp_app');
        const [b] = await tx.unsafe<{ ok: boolean }[]>(
          `UPDATE "brand" SET "status"='blacklist', "statusSince"='2010-01-01' WHERE "id"='br_winner' RETURNING "statusSince" = current_date AS ok`,
        );
        throw Object.assign(new Error('rb'), { ok: b!.ok });
      })
      .catch((e: { ok: boolean }) => e.ok);
    expect(r).toBe(true);
  });

  it('M2：bydp_app 插入 complaint / click 时伪造的 createdAt 被覆盖', async () => {
    const r = await sql!
      .begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE bydp_app');
        const [c] = await tx.unsafe<{ createdAt: Date }[]>(
          `INSERT INTO "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","createdAt")
           VALUES ('cp_t','br_winner','u_102','delay','t',1,'2026-09-01','d','2020-01-01') RETURNING "createdAt"`,
        );
        const [k] = await tx.unsafe<{ createdAt: Date }[]>(
          `INSERT INTO "click" ("id","brandId","createdAt") VALUES ('clk_t','br_winner','2020-01-01') RETURNING "createdAt"`,
        );
        const [now] = await tx.unsafe<{ now: Date }[]>('SELECT now()');
        throw Object.assign(new Error('rb'), { rows: [c!.createdAt, k!.createdAt, now!.now] });
      })
      .catch((e: { rows: Date[] }) => e.rows);
    expect(r[0]!.getTime()).toBe(r[2]!.getTime());
    expect(r[1]!.getTime()).toBe(r[2]!.getTime());
  });

  it('R1：品牌 / 案件状态变更自动写 status_history（带 actor / reason）', async () => {
    const r = await sql!
      .begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE bydp_app');
        await tx.unsafe(`SET LOCAL bydp.actor = 'arbitration_team'`);
        await tx.unsafe(`SET LOCAL bydp.status_reason = 'test'`);
        await tx.unsafe(`UPDATE "brand" SET "status"='blacklist' WHERE "id"='br_winner'`);
        await tx.unsafe(`UPDATE "complaint" SET "status"='arbitrating' WHERE "id"='cp_001'`);
        await tx.unsafe(`UPDATE "brand" SET "markets"='{MY}' WHERE "id"='br_jinlong'`); // 非状态变更不记
        const rows = await tx.unsafe<{ s: string }[]>(
          `SELECT coalesce("brandId","complaintId") || ':' || "from" || '>' || "to" || ':' || "actor" || ':' || "reason" AS s
           FROM "status_history" WHERE "at" = now() ORDER BY "id"`,
        );
        throw Object.assign(new Error('rb'), { rows: rows.map((x) => x.s) });
      })
      .catch((e: { rows: string[] }) => e.rows);
    expect(r).toEqual(['br_winner:watch>blacklist:arbitration_team:test', 'cp_001:resolved>arbitrating:arbitration_team:test']);
  });

  it('R2：信任域记录不可删，评分快照不可改（bydp_app）', async () => {
    for (const t of ['exposure', 'complaint', 'operator_reply', 'withdrawal_report', 'score_snapshot']) {
      expect(await attempt([`DELETE FROM "${t}"`], 'bydp_app'), t).toMatch(/permission denied/);
    }
    expect(await attempt([`UPDATE "score_snapshot" SET "score" = 100`], 'bydp_app')).toMatch(/permission denied/);
  });

  it('R5：status_history.from / to 限定状态值域', async () => {
    expect(await attempt([`INSERT INTO "status_history" ("brandId","to","actor") VALUES ('br_winner','banana','t')`])).toMatch(
      /status_history_status_domain/,
    );
  });

  it('bydp_app：只追加表在权限层也无 UPDATE / DELETE', async () => {
    expect(await attempt([`UPDATE "status_history" SET "reason" = 'x'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`DELETE FROM "audit_log"`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`UPDATE "evidence" SET "sha256" = '${HASH}'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`UPDATE "user_brand_binding" SET "boundAt" = now()`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`SELECT count(*) FROM "brand"`], 'bydp_app')).toBeNull();
  });
});

describe.skipIf(!url)('A-002 迁移 0003', () => {
  const ins = (event: string) => [
    `SET LOCAL bydp.allow_backfill = 'on'`,
    `INSERT INTO "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","createdAt")
     VALUES ('cp_tz','br_winner','u_102','delay','t',1,'${event}','d','2026-09-26T17:00:00Z')`,
  ];
  it('UTC+8 凌晨 01:00（UTC 前一日 17:00）提交当天事件 → 通过', async () => {
    expect(await attempt(ins('2026-09-27'))).toBeNull();
  });
  it('同一时刻填后天 → 拒绝', async () => {
    expect(await attempt(ins('2026-09-28'))).toMatch(/complaint_event_date_not_future/);
  });
  it('fromBinding 随 bindingId 生成且不可写', async () => {
    const r = await sql!<{ id: string; fromBinding: boolean }[]>`select "id", "fromBinding" from "withdrawal_report" order by "id"`;
    expect(r.map((x) => [x.id, x.fromBinding])).toEqual([['wr_001', true], ['wr_002', false], ['wr_003', true]]);
    expect(await attempt([`UPDATE "withdrawal_report" SET "fromBinding" = false`])).toMatch(/can only be updated to DEFAULT/);
    // bindingId 变化时生成列随之变化
    const flipped = await sql!
      .begin(async (tx) => {
        // A-019 起核心列对 owner 同样锁死（bydp_withdrawal_update_guard），只有回填路径可改——此处只为验证生成列语义
        await tx.unsafe(`SET LOCAL bydp.allow_backfill = 'on'`);
        await tx.unsafe(`UPDATE "withdrawal_report" SET "bindingId" = null WHERE "id" = 'wr_001'`);
        const [x] = await tx.unsafe<{ fromBinding: boolean }[]>(`SELECT "fromBinding" FROM "withdrawal_report" WHERE "id" = 'wr_001'`);
        throw Object.assign(new Error('rb'), { v: x!.fromBinding });
      })
      .catch((e: { v: boolean }) => e.v);
    expect(flipped).toBe(false);
  });
  it('scoring_ro 能读 fromBinding；bindingId 自 0004（A-005）起可读，但绑定表 / 用户表仍不可读', async () => {
    expect(await attempt([`SELECT "fromBinding" FROM "withdrawal_report"`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT "bindingId" FROM "withdrawal_report"`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT 1 FROM "user_brand_binding"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    expect(await attempt([`SELECT 1 FROM "app_user"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
  });
});

describe.skipIf(!url)('迁移 0005（A-007 tracking：G1–G4 + 审核 3 坑 + F1–F3 + R1）', () => {
  const conv = (id: string, ev: string, extra = '') =>
    `INSERT INTO "conversion" ("id","brandId","externalEventId","operatorAccountIdHash","event"${extra ? ',"reversesId"' : ''})
     VALUES ('${id}','br_jinlong','${id}','${HASH}','${ev}'${extra ? `,'${extra}'` : ''})`;
  it('坑 1：partnerId 为空的重叠条款被排除约束拒绝；不同品牌 / 不重叠通过', async () => {
    const t1 = `INSERT INTO "commission_term" ("id","brandId","mode","cpaUsdt","validFrom") VALUES ('t1','br_jinlong','cpa',50,'2026-01-01')`;
    expect(await attempt([t1, `INSERT INTO "commission_term" ("id","brandId","mode","cpaUsdt","validFrom","validTo") VALUES ('t2','br_jinlong','cpa',60,'2026-06-01','2026-12-31')`])).toMatch(/commission_term_no_overlap/);
    expect(await attempt([t1, `INSERT INTO "commission_term" ("id","brandId","mode","cpaUsdt","validFrom") VALUES ('t3','br_royal','cpa',60,'2026-06-01')`])).toBeNull();
  });
  it('坑 3：冲正须带 reversesId、同一行只能冲正一次；(brandId, externalEventId) 唯一', async () => {
    expect(await attempt([conv('c2', 'reversal')])).toMatch(/conversion_reversal_shape/);
    expect(await attempt([conv('c1', 'register'), conv('c3', 'reversal', 'c1'), conv('c4', 'reversal', 'c1')])).toMatch(/conversion_reverses_once_uq/);
    expect(await attempt([conv('c1', 'register'), conv('c1b', 'deposit').replace("'br_jinlong','c1b'", "'br_jinlong','c1'")])).toMatch(/conversion_brand_external_event_uq/);
  });
  it('G2 / F2 / 坑 2：conversion、click、commission、commission_event 只追加（owner 同拦）', async () => {
    expect(await attempt([conv('c1', 'register'), `UPDATE "conversion" SET "amountUsdt" = 1`])).toMatch(/append-only/);
    expect(await attempt([`INSERT INTO "click" ("id","brandId") VALUES ('k1','br_jinlong')`, `DELETE FROM "click"`])).toMatch(/append-only/);
    const cm = `INSERT INTO "commission" ("id","brandId","model","amountUsdt") VALUES ('m1','br_jinlong','cpa',10)`;
    expect(await attempt([cm, `UPDATE "commission" SET "amountUsdt" = 1`])).toMatch(/append-only/);
    expect(await attempt([cm, `INSERT INTO "commission_event" ("id","commissionId","status","actor") VALUES ('e1','m1','pending','t')`, `UPDATE "commission_event" SET "status" = 'paid'`])).toMatch(/append-only/);
  });
  it('F1：跳转模板形状 + 官方主机（userinfo / 反斜杠 / 非官方 / 非白名单占位符 均拒；官方主机 + 端口 + www 通过）', async () => {
    const set = (t: string) => [`UPDATE "offer" SET "redirectTemplate" = '${t}' WHERE "id" = 'of_001'`];
    for (const bad of ['https://jinlong88.com:443@evil.com/r?c={clickId}', 'https://jinlong88.com:x@evil.com/r?c={clickId}', 'https://jinlong88.com/r@evil?c={clickId}', 'https://jinlong88.com/r?c={clickId}&u={userId}'])
      expect(await attempt(set(bad)), bad).toMatch(/offer_redirect_template_shape/);
    expect(await attempt(set('https://evil.com/r?c={clickId}'))).toMatch(/official domain/);
    expect(await attempt(set('https://jinlong88.com.evil.com/r?c={clickId}'))).toMatch(/official domain/);
    for (const ok of ['https://jinlong88.com:8443/r?c={clickId}', 'https://WWW.jinlong88.com/r?c={clickId}']) expect(await attempt(set(ok)), ok).toBeNull();
  });
  it('F3：条款金额 / 模式 / 起始 / 归属不可改，仅 validTo 可设；不可删', async () => {
    const t1 = `INSERT INTO "commission_term" ("id","brandId","mode","cpaUsdt","validFrom") VALUES ('t1','br_jinlong','cpa',50,'2026-01-01')`;
    expect(await attempt([t1, `UPDATE "commission_term" SET "cpaUsdt" = 99 WHERE "id" = 't1'`])).toMatch(/only validTo/);
    expect(await attempt([t1, `UPDATE "commission_term" SET "cpaUsdt" = 99 WHERE "id" = 't1'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([t1, `UPDATE "commission_term" SET "validTo" = '2026-12-31' WHERE "id" = 't1'`], 'bydp_app')).toBeNull();
    expect(await attempt([t1, `DELETE FROM "commission_term" WHERE "id" = 't1'`])).toMatch(/append-only/);
  });
  it('R1：黑名单 / 关联方品牌写佣金在 DB 层被拒', async () => {
    const cm = (b: string) => `INSERT INTO "commission" ("id","brandId","model","amountUsdt") VALUES ('m_${b}','${b}','cpa',10)`;
    expect(await attempt([cm('br_caishen')])).toMatch(/ADR-0003/);
    expect(await attempt([cm('br_crown')])).toMatch(/ADR-0003/); // op_004 relatedParty
    expect(await attempt([cm('br_jinlong')])).toBeNull();
  });
  it('新表对 scoring_ro 不授权；bydp_app 可写 commission_event、不可删 conversion', async () => {
    for (const t of ['commission_term', 'commission_event', 'operator_integration', 'conversion', 'click'])
      expect(await attempt([`SELECT 1 FROM "${t}" LIMIT 1`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    expect(await attempt([`DELETE FROM "conversion"`], 'bydp_app')).toMatch(/permission denied/);
    expect(
      await attempt([`INSERT INTO "commission" ("id","brandId","model","amountUsdt") VALUES ('m9','br_jinlong','cpa',10)`, `INSERT INTO "commission_event" ("id","commissionId","status","actor") VALUES ('e9','m9','pending','t')`], 'bydp_app'),
    ).toBeNull();
  });
});

describe.skipIf(!url)('迁移 0006（A-009：身份盲索引 / 联系方式密文 / verification_token / sessionEpoch / validTo）', () => {
  const H2 = 'b'.repeat(64);
  const vt = (id: string, tok = H2) => `INSERT INTO "verification_token" ("identifierHash","tokenHash","expires") VALUES ('${id}','${tok}', now() + interval '15 minutes')`;
  const setAcct = (v: string) => `UPDATE "identity" SET "providerAccountId" = '${v}' WHERE "id" = 'idn_u_102_1'`;
  it('identity.providerAccountId 只能是 64 位 hex 盲索引；明文被 CHECK 拒', async () => {
    expect(await attempt([`INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('i1','u_102','email','ke@x.com')`])).toMatch(/identity_account_hash_hex/);
    expect(await attempt([`INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('i1','u_102','email','${HASH}')`], 'bydp_app')).toBeNull();
  });
  it('provider / providerAccountId 写入后不可改（NULL → 值允许一次；owner 同拦）', async () => {
    expect(await attempt([setAcct(HASH)], 'bydp_app')).toBeNull();
    expect(await attempt([setAcct(HASH), setAcct(H2)])).toMatch(/immutable/);
    expect(await attempt([`UPDATE "identity" SET "provider" = 'email' WHERE "id" = 'idn_u_102_1'`])).toMatch(/immutable/);
  });
  it('contactEnc 只接受 v1:iv:ct:tag 形状', async () => {
    expect(await attempt([`UPDATE "identity" SET "contactEnc" = 'ke@x.com' WHERE "id" = 'idn_u_102_1'`])).toMatch(/identity_contact_enc_shape/);
    expect(await attempt([`UPDATE "identity" SET "contactEnc" = 'v1:AAA=:BBB=:CCC=' WHERE "id" = 'idn_u_102_1'`], 'bydp_app')).toBeNull();
  });
  it('verification_token：bydp_app 可写 / 读 / 删、不可改；identifier 须为 hex；scoring_ro 无权', async () => {
    expect(await attempt([vt(HASH), `SELECT 1 FROM "verification_token"`, `DELETE FROM "verification_token"`], 'bydp_app')).toBeNull();
    expect(await attempt([vt(HASH), `UPDATE "verification_token" SET "expires" = now()`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([vt('ke@x.com')])).toMatch(/verification_token_identifier_hex/);
    expect(await attempt([`SELECT 1 FROM "verification_token"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
  });
  it('app_user.sessionEpoch 默认 0；bydp_app 可自增（作废全部会话）', async () => {
    expect(await attempt([`DO $$ BEGIN IF (SELECT "sessionEpoch" FROM "app_user" WHERE "id" = 'u_102') <> 0 THEN RAISE EXCEPTION 'epoch not 0'; END IF; END $$`])).toBeNull();
    expect(await attempt([`UPDATE "app_user" SET "sessionEpoch" = "sessionEpoch" + 1 WHERE "id" = 'u_102'`], 'bydp_app')).toBeNull();
  });
  it('审核建议 4：commission_term.validTo 不得设为早于今天（owner 同拦）；今天 / 清空允许', async () => {
    const t = `INSERT INTO "commission_term" ("id","brandId","mode","cpaUsdt","validFrom") VALUES ('t1','br_jinlong','cpa',50,'2026-01-01')`;
    expect(await attempt([t, `UPDATE "commission_term" SET "validTo" = current_date - 1 WHERE "id" = 't1'`])).toMatch(/earlier than today/);
    expect(await attempt([t, `UPDATE "commission_term" SET "validTo" = current_date WHERE "id" = 't1'`], 'bydp_app')).toBeNull();
    expect(await attempt([t, `UPDATE "commission_term" SET "validTo" = '2027-01-01' WHERE "id" = 't1'`, `UPDATE "commission_term" SET "validTo" = NULL WHERE "id" = 't1'`])).toBeNull();
  });
});

describe.skipIf(!url)('迁移 0007（A-010：points_event 只追加 · 分值以规则为准 · 余额只从事件派生 · 通知推送状态）', () => {
  const pe = (key: string, event = 'binding_confirmed', points = 1) =>
    `INSERT INTO "points_event" ("id","userId","event","points","refType","refId","dedupeKey") VALUES ('pe_${key}','u_102','${event}',${points},'binding','ubb_x','${key}')`;
  const newUser = (points: number, level: number) => `INSERT INTO "app_user" ("id","displayName","points","level") VALUES ('u_t','t',${points},${level})`;

  it('正常路径：bydp_app 插入事件 → 分值按规则覆盖（传 1 记 500），余额 +500、等级按门槛重算', async () => {
    const r = await attempt([
      `CREATE TEMP TABLE b ON COMMIT DROP AS SELECT "points" FROM "app_user" WHERE "id" = 'u_102'`,
      `GRANT SELECT ON b TO bydp_app`,
      `SET LOCAL ROLE bydp_app`,
      pe('k1'),
      `RESET ROLE`,
      `DO $$ BEGIN IF (SELECT "points" FROM "points_event" WHERE "id" = 'pe_k1') <> 500 THEN RAISE EXCEPTION 'rule not applied'; END IF; END $$`,
      `DO $$ DECLARE p int; BEGIN
         SELECT u."points" - b."points" INTO p FROM "app_user" u, b WHERE u."id" = 'u_102';
         IF p <> 500 THEN RAISE EXCEPTION 'balance delta %', p; END IF;
         IF (SELECT "level" <> CASE WHEN "points" >= 6000 THEN 5 WHEN "points" >= 3000 THEN 4 WHEN "points" >= 1500 THEN 3 WHEN "points" >= 500 THEN 2 ELSE 1 END
             FROM "app_user" WHERE "id" = 'u_102') THEN RAISE EXCEPTION 'level not recomputed'; END IF;
       END $$`,
    ]);
    expect(r).toBeNull();
  });
  it('同一 dedupeKey 只发一次；停用 / 不存在的规则被拒', async () => {
    expect(await attempt([pe('k2'), pe('k2').replace("'pe_k2'", "'pe_k2b'")], 'bydp_app')).toMatch(/points_event_dedupe_uq/);
    expect(await attempt([pe('k3', 'no_such_rule')])).toMatch(/is not active|foreign key/);
    expect(await attempt([`UPDATE "points_rule" SET "active" = false WHERE "event" = 'review_published'`, pe('k4', 'review_published')])).toMatch(/is not active/);
  });
  it('points_event 只追加（owner 同拦）；bydp_app 无 UPDATE / DELETE 权限', async () => {
    expect(await attempt([pe('k5'), `UPDATE "points_event" SET "refId" = 'y' WHERE "id" = 'pe_k5'`])).toMatch(/append-only/);
    expect(await attempt([pe('k5'), `DELETE FROM "points_event" WHERE "id" = 'pe_k5'`])).toMatch(/append-only/);
    expect(await attempt([`TRUNCATE "points_event"`])).toMatch(/append-only/);
    expect(await attempt([`DELETE FROM "points_event"`], 'bydp_app')).toMatch(/permission denied/);
  });
  it('C1：非 owner 新建用户不得自带积分 / 等级；普通新建通过', async () => {
    expect(await attempt([newUser(99999, 5)], 'bydp_app')).toMatch(/permission denied|start with 0 points/);
    expect(await attempt([`INSERT INTO "app_user" ("id","displayName","locale") VALUES ('u_t','t','zh-Hans')`], 'bydp_app')).toBeNull();
  });
  it('C2：bydp_app 不能改 / 增 / 删积分规则，可读', async () => {
    expect(await attempt([`UPDATE "points_rule" SET "points" = 100000 WHERE "event" = 'binding_confirmed'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`INSERT INTO "points_rule" ("event","points") VALUES ('x', 1)`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`DELETE FROM "points_rule" WHERE "event" = 'binding_confirmed'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`SELECT * FROM "points_rule"`], 'bydp_app')).toBeNull();
  });
  it('C3：任何会话 SET bydp.points_apply 后直接改 points / level 仍被拒（owner 同拦）；bydp_app 无列权限', async () => {
    expect(await attempt([`SET LOCAL bydp.points_apply = 'on'`, `UPDATE "app_user" SET "level" = 5 WHERE "id" = 'u_102'`])).toMatch(/derived from points_event/);
    expect(await attempt([`UPDATE "app_user" SET "points" = "points" + 1 WHERE "id" = 'u_102'`])).toMatch(/derived from points_event/);
    expect(await attempt([`UPDATE "app_user" SET "points" = 1 WHERE "id" = 'u_102'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`UPDATE "app_user" SET "sessionEpoch" = "sessionEpoch" + 1 WHERE "id" = 'u_102'`], 'bydp_app')).toBeNull();
  });
  it('一次性对齐：迁移后所有用户 level 与 points 门槛一致', async () => {
    const [r] = await sql!<{ n: number }[]>`
      select count(*)::int as n from "app_user"
      where "level" <> case when "points" >= 6000 then 5 when "points" >= 3000 then 4 when "points" >= 1500 then 3 when "points" >= 500 then 2 else 1 end`;
    expect(r!.n).toBe(0);
  });
  it('notification.deliveredAt / channel 成对出现（CHECK）', async () => {
    const n = `INSERT INTO "notification" ("id","userId","type","title") VALUES ('nt_t','u_102','t','t')`;
    expect(await attempt([n, `UPDATE "notification" SET "deliveredAt" = now() WHERE "id" = 'nt_t'`], 'bydp_app')).toMatch(/notification_delivery_pair/);
    expect(await attempt([n, `UPDATE "notification" SET "deliveredAt" = now(), "channel" = 'telegram' WHERE "id" = 'nt_t'`], 'bydp_app')).toBeNull();
  });
  it('审核 A-010 小项：C1 触发器层——非 owner 但有整表 INSERT 权限的角色新建用户自带积分 → 守卫拒绝', async () => {
    const setup = [`CREATE ROLE bydp_c1_probe`, `GRANT SELECT, INSERT ON "app_user" TO bydp_c1_probe`, `SET LOCAL ROLE bydp_c1_probe`];
    expect(await attempt([...setup, `INSERT INTO "app_user" ("id","displayName","points","level") VALUES ('u_t','t',99999,5)`])).toMatch(/start with 0 points/);
    expect(await attempt([...setup, `INSERT INTO "app_user" ("id","displayName") VALUES ('u_t','t')`])).toBeNull();
  });
});

describe.skipIf(!url)('迁移 0008（A-011：绑定账号加密过渡 · 自我排除 · 限额提醒偏好 · 数据请求）', () => {
  const H = 'c'.repeat(64);
  /** 在事务内断言：条件为假时抛出 msg（attempt 返回该信息） */
  const check = (cond: string, msg: string) => `DO $$ BEGIN IF NOT (${cond}) THEN RAISE EXCEPTION '${msg}'; END IF; END $$`;
  const ins = (cols: string, vals: string) =>
    `INSERT INTO "user_brand_binding" ("id","userId","brandId","operatorAccountIdHash","source"${cols}) VALUES ('ubb_t','u_233','br_royal','${H}','manual'${vals})`;
  const setHash = `UPDATE "identity" SET "providerAccountId"='${H}' WHERE "id"='idn_u_102_1'`;
  const perm = [setHash, `INSERT INTO "self_exclusion" ("id","userId","period") VALUES ('se_p','u_102','permanent')`];
  const dr = (kind: string, ids = '[]', note = 'NULL') =>
    `INSERT INTO "data_request" ("id","userId","kind","targetIds","note") VALUES ('dr_t','u_233','${kind}','${ids}'::jsonb,${note})`;

  it('绑定（0008 + 0009 后）：明文列已不存在；bydp_app 只写密文 + 掩码通过；缺掩码 → NOT NULL；密文形状不对 → CHECK', async () => {
    expect(await attempt([ins(',"operatorAccountId"', ",'X-1'")], 'bydp_app')).toMatch(/operatorAccountId.*does not exist/);
    expect(await attempt([ins(',"operatorAccountIdEnc","operatorAccountIdMasked"', `,'${ENC}','X***1'`)], 'bydp_app')).toBeNull();
    expect(await attempt([ins(',"operatorAccountIdEnc"', `,'${ENC}'`)])).toMatch(/not-null|null value/);
    expect(await attempt([ins(',"operatorAccountIdEnc","operatorAccountIdMasked"', `,'plain','X***1'`)])).toMatch(/binding_account_enc_shape/);
  });
  it('绑定：owner 改密文 / 掩码 → 守卫拒绝（A-012 守卫无明文分支，写入后一律不可改）', async () => {
    expect(await attempt([`UPDATE "user_brand_binding" SET "operatorAccountIdEnc"='v1:ZZZ=:BBB=:CCC=' WHERE "id"='ubb_001'`])).toMatch(/immutable/);
    expect(await attempt([`UPDATE "user_brand_binding" SET "operatorAccountIdMasked"='x' WHERE "id"='ubb_001'`])).toMatch(/immutable/);
  });
  it('绑定：bydp_app 改密文 → permission denied；改核验等级仍可', async () => {
    expect(await attempt([`UPDATE "user_brand_binding" SET "operatorAccountIdEnc"='${ENC}' WHERE "id"='ubb_001'`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([`UPDATE "user_brand_binding" SET "verificationLevel"='postback_confirmed' WHERE "id"='ubb_001'`], 'bydp_app')).toBeNull();
  });
  it('自我排除：应用层伪造的 startsAt / endsAt / identityHashes 一律被触发器覆盖（服务端时间、+30 天、非永久无快照）', async () => {
    expect(
      await attempt(
        [
          `INSERT INTO "self_exclusion" ("id","userId","period","startsAt","endsAt","identityHashes") VALUES ('se_t','u_233','30','2020-01-01',NULL,ARRAY['${H}'])`,
          check(
            `(SELECT "startsAt" > now() - interval '1 minute' AND "endsAt" - "startsAt" = interval '30 days' AND cardinality("identityHashes") = 0 FROM "self_exclusion" WHERE "id"='se_t')`,
            'forged values kept',
          ),
        ],
        'bydp_app',
      ),
    ).toBeNull();
  });
  it('自我排除 permanent：endsAt 为空，快照 = 本人全部身份盲索引', async () => {
    expect(
      await attempt([...perm, check(`(SELECT "endsAt" IS NULL AND "identityHashes" = ARRAY['${H}'] FROM "self_exclusion" WHERE "id"='se_p')`, 'bad snapshot')], 'bydp_app'),
    ).toBeNull();
  });
  it('自我排除只追加：UPDATE / DELETE（owner）→ append-only；bydp_app DELETE → permission denied', async () => {
    expect(await attempt([...perm, `UPDATE "self_exclusion" SET "period"='30' WHERE "id"='se_p'`])).toMatch(/append-only/);
    expect(await attempt([...perm, `DELETE FROM "self_exclusion" WHERE "id"='se_p'`])).toMatch(/append-only/);
    expect(await attempt([...perm, `DELETE FROM "self_exclusion"`], 'bydp_app')).toMatch(/permission denied/);
  });
  it('permanent 身份不可再注册到他人：他人新建同一哈希身份 / 身份改挂他人 / 匿名化后他人用同一哈希注册 → 拒绝', async () => {
    expect(await attempt([...perm, `UPDATE "identity" SET "userId"='u_233' WHERE "id"='idn_u_102_1'`])).toMatch(/permanently self-excluded/);
    const anon = [`ALTER TABLE "identity" DISABLE TRIGGER USER`, `UPDATE "identity" SET "providerAccountId"=NULL WHERE "id"='idn_u_102_1'`, `ALTER TABLE "identity" ENABLE TRIGGER USER`];
    expect(
      await attempt([...perm, ...anon, `INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('idn_new','u_233','telegram','${H}')`]),
    ).toMatch(/permanently self-excluded/);
    expect(await attempt([...perm, `INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('idn_new','u_233','email','${'d'.repeat(64)}')`])).toBeNull();
  });
  it('审核 A-011 D1：permanent 之后本人不得新增快照外身份（新建 / 旧身份补填哈希均拒）；快照内身份照常', async () => {
    const h2 = 'f'.repeat(64);
    expect(await attempt([...perm, `INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('idn_h2','u_102','email','${h2}')`], 'bydp_app')).toMatch(
      /cannot add identities/,
    );
    expect(
      await attempt([...perm, `INSERT INTO "identity" ("id","userId","provider") VALUES ('idn_h2','u_102','email')`, `UPDATE "identity" SET "providerAccountId"='${h2}' WHERE "id"='idn_h2'`], 'bydp_app'),
    ).toMatch(/cannot add identities/);
    expect(await attempt([...perm, `UPDATE "identity" SET "handle"='x' WHERE "id"='idn_u_102_1'`], 'bydp_app')).toBeNull();
  });
  it('偏好：bydp_app upsert 通过；在线提醒 5 分钟 → CHECK；DELETE / 改 userId → permission denied', async () => {
    const up = `INSERT INTO "user_preference" ("userId","dailyDepositAlertUsdt","sessionAlertMinutes","nightAlert") VALUES ('u_233',500,120,false) ON CONFLICT ("userId") DO UPDATE SET "nightAlert"=true`;
    expect(await attempt([up, up], 'bydp_app')).toBeNull();
    expect(await attempt([`INSERT INTO "user_preference" ("userId","sessionAlertMinutes") VALUES ('u_233',5)`], 'bydp_app')).toMatch(/user_preference_session_range/);
    expect(await attempt([up, `DELETE FROM "user_preference"`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([up, `UPDATE "user_preference" SET "userId"='u_102'`], 'bydp_app')).toMatch(/permission denied/);
  });
  it('数据请求：只有证据类可带 targetIds；note ≤ 200；bydp_app 不能新建非待处理（status / resolvedAt 无 INSERT 权限）', async () => {
    expect(await attempt([dr('export', '["ev_1"]')], 'bydp_app')).toMatch(/data_request_targets_only_evidence/);
    expect(await attempt([dr('redact_evidence', '["ev_1"]')], 'bydp_app')).toBeNull();
    expect(await attempt([dr('export', '[]', `'${'x'.repeat(201)}'`)], 'bydp_app')).toMatch(/data_request_note_len/);
    expect(await attempt([`INSERT INTO "data_request" ("id","userId","kind","status","resolvedAt") VALUES ('dr_t','u_233','export','done',now())`], 'bydp_app')).toMatch(
      /permission denied/,
    );
  });
  it('数据请求：pending → done 时 resolvedAt 由服务端写入；终态不可再改；改 note / 直接改 resolvedAt → 拒绝；不可删（owner 同拦）', async () => {
    const done = `UPDATE "data_request" SET "status"='done' WHERE "id"='dr_t'`;
    expect(await attempt([dr('export'), done, check(`(SELECT "resolvedAt" IS NOT NULL FROM "data_request" WHERE "id"='dr_t')`, 'no resolvedAt')], 'bydp_app')).toBeNull();
    expect(await attempt([dr('export'), done, `UPDATE "data_request" SET "status"='rejected' WHERE "id"='dr_t'`], 'bydp_app')).toMatch(/is final/);
    expect(await attempt([dr('export'), `UPDATE "data_request" SET "note"='x' WHERE "id"='dr_t'`])).toMatch(/only status( \/ contact confirmation)? can change/);
    expect(await attempt([dr('export'), `UPDATE "data_request" SET "resolvedAt"=now() WHERE "id"='dr_t'`], 'bydp_app')).toMatch(/server-set/);
    expect(await attempt([dr('export'), `DELETE FROM "data_request"`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([dr('export'), `DELETE FROM "data_request"`])).toMatch(/append-only/);
  });
});

describe.skipIf(!url)('迁移 0009 / 0010（A-012：删明文列 · 删 selfExcludedUntil · 待处理唯一 · 通知已跳过；A-013：conversion 只存盲索引）', () => {
  const H = 'c'.repeat(64);
  const col = async (table: string, column: string) =>
    (await sql!<{ n: number }[]>`select count(*)::int as n from information_schema.columns where table_name = ${table} and column_name = ${column}`)[0]!.n;
  const dr = (id: string, kind = 'export') => `INSERT INTO "data_request" ("id","userId","kind") VALUES ('${id}','u_233','${kind}')`;
  const nt = `INSERT INTO "notification" ("id","userId","type","title") VALUES ('nt_t','u_233','t','t')`;
  const cv = (raw: string) =>
    `INSERT INTO "conversion" ("id","brandId","externalEventId","operatorAccountIdHash","event","raw") VALUES ('cv_t','br_jinlong','e-1','${H}','first_deposit','${raw}')`;

  it('A-012：绑定明文列与 app_user.selfExcludedUntil 已删除；密文 / 掩码 NOT NULL；bydp_app 建用户、改语言照常', async () => {
    expect([await col('user_brand_binding', 'operatorAccountId'), await col('app_user', 'selfExcludedUntil')]).toEqual([0, 0]);
    const nn = await sql!<{ c: string; n: string }[]>`
      select column_name as c, is_nullable as n from information_schema.columns
      where table_name = 'user_brand_binding' and column_name in ('operatorAccountIdEnc', 'operatorAccountIdMasked') order by 1`;
    expect(nn).toEqual([{ c: 'operatorAccountIdEnc', n: 'NO' }, { c: 'operatorAccountIdMasked', n: 'NO' }]);
    expect(await attempt([`INSERT INTO "app_user" ("id","displayName","locale") VALUES ('u_t','t','zh-Hans')`, `UPDATE "app_user" SET "locale"='en' WHERE "id"='u_t'`], 'bydp_app')).toBeNull();
  });
  it('A-012 #20：同一用户同类待处理请求只能一条；不同类可并存；处理完后可再建', async () => {
    expect(await attempt([dr('dr_a'), dr('dr_b')], 'bydp_app')).toMatch(/data_request_pending_uq/);
    expect(await attempt([dr('dr_a'), dr('dr_b', 'anonymize')], 'bydp_app')).toBeNull();
    expect(await attempt([dr('dr_a'), `UPDATE "data_request" SET "status"='done' WHERE "id"='dr_a'`, dr('dr_b')], 'bydp_app')).toBeNull();
  });
  it('A-012 #19：通知「已跳过」——bydp_app 可标记；时刻与原因成对、原因限两值、已送达与已跳过互斥', async () => {
    expect(await attempt([nt, `UPDATE "notification" SET "skippedAt"=now(), "skipReason"='tg_blocked' WHERE "id"='nt_t'`], 'bydp_app')).toBeNull();
    expect(await attempt([nt, `UPDATE "notification" SET "skippedAt"=now() WHERE "id"='nt_t'`], 'bydp_app')).toMatch(/notification_skip_pair/);
    expect(await attempt([nt, `UPDATE "notification" SET "skippedAt"=now(), "skipReason"='whatever' WHERE "id"='nt_t'`], 'bydp_app')).toMatch(/notification_skip_reason/);
    expect(
      await attempt([nt, `UPDATE "notification" SET "deliveredAt"=now(), "channel"='telegram', "skippedAt"=now(), "skipReason"='no_contact' WHERE "id"='nt_t'`], 'bydp_app'),
    ).toMatch(/notification_delivered_xor_skipped/);
  });
  it('A-013：conversion 明文列已删除；raw 含账号 → CHECK 拒绝（NOT VALID：只约束新写入）；干净 raw 通过；只追加照旧', async () => {
    expect(await col('conversion', 'operatorAccountId')).toBe(0);
    expect(await attempt([cv('{"operatorAccountId":"X"}')], 'bydp_app')).toMatch(/conversion_raw_no_account/);
    expect(await attempt([cv('{"event":"first_deposit"}')], 'bydp_app')).toBeNull();
    const [c] = await sql!<{ v: boolean }[]>`select convalidated as v from pg_constraint where conname = 'conversion_raw_no_account'`;
    expect(c!.v).toBe(false);
    expect(await attempt([cv('{"event":"first_deposit"}'), `UPDATE "conversion" SET "amountUsdt"=1 WHERE "id"='cv_t'`])).toMatch(/append-only/);
  });
});

describe.skipIf(!url)('迁移 0011（A-014：公开陈述 · 脱敏件哈希 · 注销联系确认 · review_item）', () => {
  const H = 'd'.repeat(64);
  const check = (cond: string, msg: string) => `DO $$ BEGIN IF NOT (${cond}) THEN RAISE EXCEPTION '${msg}'; END IF; END $$`;
  const cp = `INSERT INTO "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","status") VALUES ('cp_t11','br_winner','u_233','delay','t',1,'2026-09-20','ascii text','screening')`;
  const ev = `${cp}; INSERT INTO "evidence" ("id","complaintId","type","sha256","storageKey") VALUES ('ev_t11','cp_t11','screenshot','${'a'.repeat(64)}','evidence/cp_t11/ev_t11')`;
  const dr = (kind: string) => `INSERT INTO "data_request" ("id","userId","kind") VALUES ('dr_t11','u_233','${kind}')`;
  const ri = `INSERT INTO "review_item" ("id","kind","subject","proposal","source") VALUES ('ri_t11','brand_attribute','br_jinlong','{"field":"licenseNo"}','collector@0.1')`;

  it('公开陈述：已公开存量均有公开陈述；公开须有陈述；1–500 字（中文按字计）；公开后可修订；scoring_ro 不可读', async () => {
    const [n] = await sql!<{ n: number }[]>`select count(*)::int as n from "complaint" where "publicSummary" and "publicDescription" is null`;
    expect(n!.n).toBe(0);
    expect(await attempt([cp, `UPDATE "complaint" SET "publicSummary"=true WHERE "id"='cp_t11'`], 'bydp_app')).toMatch(/complaint_public_needs_text/);
    expect(await attempt([cp, `UPDATE "complaint" SET "publicSummary"=true, "publicDescription"='脱敏后陈述' WHERE "id"='cp_t11'`], 'bydp_app')).toBeNull();
    expect(await attempt([cp, `UPDATE "complaint" SET "publicDescription"='' WHERE "id"='cp_t11'`], 'bydp_app')).toMatch(/complaint_public_description_len/);
    expect(await attempt([cp, `UPDATE "complaint" SET "publicDescription"='${'中'.repeat(500)}' WHERE "id"='cp_t11'`], 'bydp_app')).toBeNull();
    expect(await attempt([cp, `UPDATE "complaint" SET "publicDescription"='${'中'.repeat(501)}' WHERE "id"='cp_t11'`], 'bydp_app')).toMatch(/complaint_public_description_len/);
    expect(await attempt([`UPDATE "complaint" SET "publicDescription"='修订版' WHERE "id"='cp_002'`], 'bydp_app')).toBeNull();
    expect(await attempt([`SELECT "publicDescription" FROM "complaint" LIMIT 1`], 'bydp_scoring_ro')).toMatch(/permission denied/);
  });
  it('脱敏件哈希：只能随标记脱敏一次写入；之后不可改；须 hex；原文哈希仍锁定', async () => {
    const redact = `UPDATE "evidence" SET "redacted"=true, "redactedAt"=now(), "storageKey"='evidence/cp_t11/ev_t11.r', "redactedSha256"='${H}' WHERE "id"='ev_t11'`;
    expect(await attempt([ev, redact], 'bydp_app')).toBeNull();
    expect(await attempt([ev, `UPDATE "evidence" SET "redactedSha256"='${H}' WHERE "id"='ev_t11'`], 'bydp_app')).toMatch(/set once together with redaction/);
    expect(await attempt([ev, redact, `UPDATE "evidence" SET "redactedSha256"='${'e'.repeat(64)}' WHERE "id"='ev_t11'`])).toMatch(/set once together with redaction/);
    expect(await attempt([ev, `UPDATE "evidence" SET "redacted"=true, "redactedSha256"='nothex' WHERE "id"='ev_t11'`], 'bydp_app')).toMatch(/evidence_redacted_sha256_hex/);
    expect(await attempt([ev, `UPDATE "evidence" SET "sha256"='${H}' WHERE "id"='ev_t11'`])).toMatch(/append-only/);
  });
  it('注销联系确认：只 anonymize、待处理时一次、时刻服务端；审核 E1：未确认不得 done，确认后可 done，rejected 不受限', async () => {
    const confirm = `UPDATE "data_request" SET "contactChannel"='telegram', "contactConfirmedAt"='2020-01-01' WHERE "id"='dr_t11'`;
    expect(
      await attempt([dr('anonymize'), confirm, check(`(select "contactConfirmedAt" > now() - interval '1 minute' from data_request where id='dr_t11')`, 'not server time')], 'bydp_app'),
    ).toBeNull();
    expect(await attempt([dr('export'), `UPDATE "data_request" SET "contactChannel"='email' WHERE "id"='dr_t11'`], 'bydp_app')).toMatch(/data_request_contact_only_anonymize/);
    expect(await attempt([dr('anonymize'), confirm, `UPDATE "data_request" SET "contactChannel"='email' WHERE "id"='dr_t11'`], 'bydp_app')).toMatch(/set once while pending/);
    expect(await attempt([dr('anonymize'), `UPDATE "data_request" SET "contactConfirmedAt"=now() WHERE "id"='dr_t11'`])).toMatch(/server-set/);
    // E1
    expect(await attempt([dr('anonymize'), `UPDATE "data_request" SET "status"='done' WHERE "id"='dr_t11'`], 'bydp_app')).toMatch(/data_request_anonymize_needs_contact/);
    expect(await attempt([dr('anonymize'), confirm, `UPDATE "data_request" SET "status"='done' WHERE "id"='dr_t11'`], 'bydp_app')).toBeNull();
    expect(await attempt([dr('anonymize'), `UPDATE "data_request" SET "status"='rejected' WHERE "id"='dr_t11'`], 'bydp_app')).toBeNull();
    expect(await attempt([dr('export'), `UPDATE "data_request" SET "status"='done' WHERE "id"='dr_t11'`], 'bydp_app')).toBeNull();
  });
  it('review_item：新建只能 pending；决定一次、时刻服务端；提案不可改；不可删；审核 E2：决定人须为真实用户（外键）', async () => {
    const decide = (by: string) => `UPDATE "review_item" SET "status"='approved', "decidedBy"='${by}', "decidedAt"='2020-01-01', "note"='ok' WHERE "id"='ri_t11'`;
    expect(await attempt([ri, check(`(select status = 'pending' from review_item where id='ri_t11')`, 'not pending')], 'bydp_app')).toBeNull();
    expect(await attempt([`INSERT INTO "review_item" ("id","kind","subject","proposal","source","status") VALUES ('ri_t11','brand_attribute','b','{}','a','approved')`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([ri, decide('u_102'), check(`(select "decidedAt" > now() - interval '1 minute' from review_item where id='ri_t11')`, 'not server time')], 'bydp_app')).toBeNull();
    expect(await attempt([ri, decide('nobody')], 'bydp_app')).toMatch(/review_item_decidedBy_app_user_id_fk/);
    expect(await attempt([ri, decide('u_102'), `UPDATE "review_item" SET "status"='rejected', "decidedBy"='u_233' WHERE "id"='ri_t11'`], 'bydp_app')).toMatch(/is final/);
    expect(await attempt([ri, `UPDATE "review_item" SET "proposal"='{"x":1}' WHERE "id"='ri_t11'`])).toMatch(/immutable/);
    expect(await attempt([ri, `UPDATE "review_item" SET "note"='x' WHERE "id"='ri_t11'`], 'bydp_app')).toMatch(/only a decision/);
    expect(await attempt([ri, `UPDATE "review_item" SET "status"='rejected' WHERE "id"='ri_t11'`], 'bydp_app')).toMatch(/review_item_decided_pair/);
    expect(await attempt([ri, `DELETE FROM "review_item"`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attempt([ri, `DELETE FROM "review_item"`])).toMatch(/append-only/);
    expect(await attempt([`INSERT INTO "review_item" ("id","kind","subject","proposal","source") VALUES ('ri_t11','brand_attribute','b','[1]','a')`], 'bydp_app')).toMatch(/review_item_proposal_object/);
  });
});

describe.skipIf(!url)('bydp_scoring_ro 隔离（ADR-0006 第 ③ 层）', () => {
  const allowed = ['operator', 'identifier', 'entity_link', 'license', 'brand_attribute', 'candidate', 'status_history', 'score_snapshot', 'operator_reply', 'exposure', 'exposure_complaint'];
  const columnLevel = ['brand', 'withdrawal_report', 'complaint', 'review'];
  const denied = [
    'offer', 'promo_code', 'click', 'conversion', 'commission', 'partner', 'affiliate_complaint', 'commission_term', 'commission_event', 'operator_integration', 'verification_token',
    'deposit', 'claim', 'payout', 'app_user', 'user_role', 'identity', 'device', 'user_brand_binding', 'subscription', 'notification',
    'audit_log', 'evidence', 'points_rule', 'points_event', 'self_exclusion', 'user_preference', 'data_request', 'review_item', 'identity_block', 'candidate_query', 'site_check',
    'submission_evidence', // A-019
  ];

  it.each(allowed)('可读 %s', async (t) => {
    expect(await attempt([`SELECT * FROM "${t}" LIMIT 1`], 'bydp_scoring_ro')).toBeNull();
  });
  it.each(denied)('不可读 %s', async (t) => {
    expect(await attempt([`SELECT 1 FROM "${t}" LIMIT 1`], 'bydp_scoring_ro')).toMatch(/permission denied/);
  });
  it('brand / withdrawal_report 仅列级：不含保证金；withdrawal_report 列级清单固定', async () => {
    expect(await attempt([`SELECT "id","status","markets" FROM "brand"`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT "certifiedDepositUsdt" FROM "brand"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    expect(await attempt([`SELECT "brandId","outcome","receivedAt" FROM "withdrawal_report"`], 'bydp_scoring_ro')).toBeNull();
    const cols = await sql!<{ c: string }[]>`
      select column_name as c from information_schema.column_privileges
      where grantee = 'bydp_scoring_ro' and table_name = 'withdrawal_report' and privilege_type = 'SELECT' order by 1`;
    // A-019：+ status（只计 accepted）；userId / decidedBy / rejectReason / outcomeAmendedAt 不授予
    expect(cols.map((x) => x.c)).toEqual(['amountUsdt', 'bindingId', 'brandId', 'complaintId', 'createdAt', 'fromBinding', 'id', 'kind', 'method', 'outcome', 'receivedAt', 'requestedAt', 'status']);
  });
  it('complaint / review 仅列级：可读因子列，不可读用户列', async () => {
    expect(await attempt([`SELECT "brandId","status","acceptedAt" FROM "complaint"`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT "userId" FROM "complaint"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    expect(await attempt([`SELECT "brandId","rating","trustWeight" FROM "review"`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT "text" FROM "review"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    // A-019：可读 status（只计 published）；bindingId / decidedBy 不可读
    expect(await attempt([`SELECT "status" FROM "review"`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT "decidedBy" FROM "review"`], 'bydp_scoring_ro')).toMatch(/permission denied/);
  });
  it('不可写（含 score_snapshot）', async () => {
    expect(
      await attempt([`INSERT INTO "score_snapshot" ("brandId","algorithmVersion","confidence","factorsAvailable","factorsTotal") VALUES ('br_jinlong','x','none',0,5)`], 'bydp_scoring_ro'),
    ).toMatch(/permission denied/);
  });
  it('白名单与 20_roles.sql 一致：scoring 可读表集合 = allowed + 列级表', async () => {
    const rows = await sql!<{ t: string }[]>`
      select distinct table_name as t from information_schema.column_privileges
      where grantee = 'bydp_scoring_ro' and privilege_type = 'SELECT' order by 1`;
    expect(rows.map((r) => r.t).sort()).toEqual([...allowed, ...columnLevel].sort());
    expect(rows).toHaveLength(15); // ADR-0006「白名单清单（15 张）」
  });
});

// ---------------- 迁移 0012（A-015：注销匿名化 · 绑定失效 · 角色互斥 · review_item 待决唯一）----------------
/** 同 attempt，步骤里 '@app' / '@owner' 切换角色（SET LOCAL ROLE bydp_app / RESET ROLE） */
async function attemptSteps(stmts: string[]): Promise<string | null> {
  try {
    await sql!.begin(async (tx) => {
      for (const s of stmts) {
        if (s === '@app') await tx.unsafe('SET LOCAL ROLE bydp_app');
        else if (s === '@owner') await tx.unsafe('RESET ROLE');
        else await tx.unsafe(s);
      }
      throw ROLLBACK;
    });
    return null;
  } catch (e) {
    return e === ROLLBACK ? null : (e as Error).message;
  }
}
const must = (cond: string, msg: string) => `DO $$ BEGIN IF NOT (${cond}) THEN RAISE EXCEPTION '${msg}'; END IF; END $$`;
const H = (c: string) => c.repeat(64);
/** 夹具：u_anon 有积分 500 / 绑定 / 身份 / 偏好 / 订阅 / 通知 / 角色，且有已联系确认的注销请求 dr_anon */
const ANON_FIX = [
  `INSERT INTO "app_user" ("id","displayName","region") VALUES ('u_anon','张三','HK')`,
  `INSERT INTO "identity" ("id","userId","provider","providerAccountId","handle") VALUES ('id_anon','u_anon','telegram','${H('a')}','@zhangsan')`,
  `INSERT INTO "user_brand_binding" ("id","userId","brandId","operatorAccountIdHash","operatorAccountIdEnc","operatorAccountIdMasked","source")
     VALUES ('ubb_anon','u_anon','br_winner','${H('b')}','${ENC}','ab***yz','manual')`,
  `INSERT INTO "points_event" ("id","userId","event","points","refType","refId","dedupeKey") VALUES ('pe_anon','u_anon','binding_confirmed',1,'binding','ubb_anon','bc:ubb_anon')`,
  `INSERT INTO "user_preference" ("userId","nightAlert") VALUES ('u_anon', true)`,
  `INSERT INTO "subscription" ("id","userId","targetType","targetId") VALUES ('sub_anon','u_anon','brand','br_winner')`,
  `INSERT INTO "notification" ("id","userId","type","title") VALUES ('nt_anon','u_anon','system','hi')`,
  `INSERT INTO "user_role" ("userId","roleKey") VALUES ('u_anon','editor')`,
  `INSERT INTO "data_request" ("id","userId","kind") VALUES ('dr_anon','u_anon','anonymize')`,
  `UPDATE "data_request" SET "contactChannel"='telegram' WHERE "id"='dr_anon'`,
];
const ANON = `SELECT bydp_anonymize_user('u_anon','dr_anon')`;
const NEW_USER = `INSERT INTO "app_user" ("id","displayName") VALUES ('u_new','新用户')`;
const NEW_IDENTITY = `INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('id_new','u_new','telegram','${H('a')}')`;
const NEW_BINDING = `INSERT INTO "user_brand_binding" ("id","userId","brandId","operatorAccountIdHash","operatorAccountIdEnc","operatorAccountIdMasked","source")
  VALUES ('ubb_new','u_new','br_winner','${H('b')}','${ENC}','ab***yz','manual')`;
const reversal = `INSERT INTO "points_event" ("id","userId","event","points","refType","refId","dedupeKey") VALUES ('pe_rev','u_anon','anonymize_reversal',-500,'data_request','dr_anon','anonymize:dr_anon')`;

describe.skipIf(!url)('迁移 0012（A-015：注销匿名化 · 绑定失效 · 角色互斥 · review_item 待决唯一）', () => {
  it('角色参照四行；仲裁员与商务互斥（bydp_app 与 owner 都拦，含 UPDATE）；其他组合通过', async () => {
    const [r] = await sql!`select string_agg("key"::text, ',' order by "key") as "k" from "role"`;
    expect(r!.k).toBe('arbitrator,commerce,editor,admin');
    const ex = /mutually exclusive/;
    expect(await attempt([`INSERT INTO "user_role" VALUES ('u_233','arbitrator')`, `INSERT INTO "user_role" VALUES ('u_233','commerce')`], 'bydp_app')).toMatch(ex);
    expect(await attempt([`INSERT INTO "user_role" VALUES ('u_233','commerce')`, `INSERT INTO "user_role" VALUES ('u_233','arbitrator')`])).toMatch(ex);
    expect(await attempt([`INSERT INTO "user_role" VALUES ('u_233','arbitrator')`, `INSERT INTO "user_role" VALUES ('u_233','editor')`], 'bydp_app')).toBeNull();
    expect(
      await attempt(
        [`INSERT INTO "user_role" VALUES ('u_233','arbitrator')`, `INSERT INTO "user_role" VALUES ('u_233','editor')`, `UPDATE "user_role" SET "roleKey"='commerce' WHERE "userId"='u_233' AND "roleKey"='editor'`],
        'bydp_app',
      ),
    ).toMatch(ex);
  });

  it('review_item：同一对象同类只能一条待决；决定后可再提；不同对象互不影响', async () => {
    const ri = (id: string, subject = 'br_jinlong') => `INSERT INTO "review_item" ("id","kind","subject","proposal","source") VALUES ('${id}','brand_attribute','${subject}','{"f":1}','collector@0.1')`;
    expect(await attempt([ri('ri_1'), ri('ri_2')], 'bydp_app')).toMatch(/review_item_pending_subject_uq/);
    expect(await attempt([ri('ri_1'), `UPDATE "review_item" SET "status"='rejected', "decidedBy"='u_233', "decidedAt"=now() WHERE "id"='ri_1'`, ri('ri_2')], 'bydp_app')).toBeNull();
    expect(await attempt([ri('ri_1'), ri('ri_2', 'br_winner')], 'bydp_app')).toBeNull();
  });

  it('积分冲销只能在 bydp_anonymize_user 内：bydp_app（含自设参数）与 owner 不设参数都拒绝；其他事件负分被规则覆盖；参照行停用', async () => {
    const only = /only via bydp_anonymize_user/;
    expect(await attemptSteps([...ANON_FIX, '@app', reversal])).toMatch(only);
    expect(await attemptSteps([...ANON_FIX, '@app', `SELECT set_config('bydp.anonymize','dr_anon',true)`, reversal])).toMatch(only);
    expect(await attemptSteps([...ANON_FIX, reversal])).toMatch(only);
    expect(
      await attempt(
        [`INSERT INTO "points_event" ("id","userId","event","points","refType","refId","dedupeKey") VALUES ('pe_x','u_233','binding_confirmed',-5,'binding','x','bc:x')`, must(`(select points = 500 from points_event where id='pe_x')`, 'rule not applied')],
        'bydp_app',
      ),
    ).toBeNull();
    const [rule] = await sql!`select "points", "active" from "points_rule" where "event" = 'anonymize_reversal'`;
    expect(rule).toEqual({ points: 0, active: false });
  });

  it('revokedAt / anonymizedAt：bydp_app 无权限；owner 不设参数被拒；写一次后不可改（owner 设参数也不行）；匿名化后资料冻结', async () => {
    const once = /write-once, only via bydp_anonymize_user/;
    expect(await attemptSteps([...ANON_FIX, '@app', `UPDATE "user_brand_binding" SET "revokedAt"=now() WHERE "id"='ubb_anon'`])).toMatch(/permission denied/);
    expect(await attemptSteps([...ANON_FIX, `UPDATE "user_brand_binding" SET "revokedAt"=now() WHERE "id"='ubb_anon'`])).toMatch(once);
    expect(await attemptSteps([...ANON_FIX, '@app', ANON, '@owner', `UPDATE "user_brand_binding" SET "revokedAt"=now() - interval '1 day' WHERE "id"='ubb_anon'`])).toMatch(once);
    expect(await attemptSteps([...ANON_FIX, '@app', ANON, '@owner', `SELECT set_config('bydp.anonymize','dr_anon',true)`, `UPDATE "user_brand_binding" SET "revokedAt"=NULL WHERE "id"='ubb_anon'`])).toMatch(once);
    expect(await attemptSteps([...ANON_FIX, '@app', `UPDATE "app_user" SET "anonymizedAt"=now() WHERE "id"='u_anon'`])).toMatch(/permission denied/);
    expect(await attemptSteps([...ANON_FIX, `UPDATE "app_user" SET "anonymizedAt"=now() WHERE "id"='u_anon'`])).toMatch(once);
    expect(await attemptSteps([...ANON_FIX, '@app', ANON, `UPDATE "app_user" SET "displayName"='李四' WHERE "id"='u_anon'`])).toMatch(/profile is frozen/);
  });

  it('函数前置：请求不存在 / 未联系确认 / 他人请求 / 非注销请求 / 执行两次 均拒绝；scoring_ro 无执行权限', async () => {
    expect(await attemptSteps([...ANON_FIX, '@app', `SELECT bydp_anonymize_user('u_anon','dr_none')`])).toMatch(/no pending anonymize request/);
    expect(await attemptSteps([...ANON_FIX, `INSERT INTO "data_request" ("id","userId","kind") VALUES ('dr_b','u_233','anonymize')`, '@app', `SELECT bydp_anonymize_user('u_233','dr_b')`])).toMatch(
      /contact confirmation required/,
    );
    expect(await attemptSteps([...ANON_FIX, '@app', `SELECT bydp_anonymize_user('u_233','dr_anon')`])).toMatch(/no pending anonymize request/);
    expect(await attemptSteps([...ANON_FIX, `INSERT INTO "data_request" ("id","userId","kind") VALUES ('dr_e','u_233','export')`, '@app', `SELECT bydp_anonymize_user('u_233','dr_e')`])).toMatch(
      /no pending anonymize request/,
    );
    expect(await attemptSteps([...ANON_FIX, '@app', ANON, ANON])).toMatch(/already anonymized/);
    expect(await attemptSteps([...ANON_FIX, 'SET LOCAL ROLE bydp_scoring_ro', ANON])).toMatch(/permission denied for function/);
  });

  it('全流程（bydp_app 调用）：积分冲销归零、绑定失效、身份 / 偏好 / 订阅 / 通知 / 角色清除、昵称替换、会话失效；保留行与快照；返回计数', async () => {
    expect(
      await attemptSteps([
        ...ANON_FIX,
        '@app',
        ANON,
        '@owner',
        must(
          `(select points = 0 and level = 1 and "displayName" = '已注销用户' and region is null and "sessionEpoch" = 1 and "anonymizedAt" > now() - interval '1 minute' from app_user where id='u_anon')`,
          'user not anonymized',
        ),
        must(`(select count(*) = 1 from points_event where "userId"='u_anon' and event='anonymize_reversal' and points = -500 and "dedupeKey" = 'anonymize:dr_anon')`, 'no reversal'),
        must(`(select count(*) = 2 from points_event where "userId"='u_anon')`, 'points rows not kept'),
        must(`(select "revokedAt" is not null and not "compensationEligible" and "operatorAccountIdHash" = '${H('b')}' from user_brand_binding where id='ubb_anon')`, 'binding not revoked'),
        must(
          `not exists (select 1 from identity where "userId"='u_anon') and not exists (select 1 from user_preference where "userId"='u_anon')
           and not exists (select 1 from subscription where "userId"='u_anon') and not exists (select 1 from notification where "userId"='u_anon')
           and not exists (select 1 from user_role where "userId"='u_anon')`,
          'pii left',
        ),
        must(`(select status = 'pending' from data_request where id='dr_anon')`, 'request status touched'),
        must(`coalesce(current_setting('bydp.anonymize', true), '') = ''`, 'guc leaked'),
      ]),
    ).toBeNull();
    let counts: unknown;
    await sql!
      .begin(async (tx) => {
        for (const s of ANON_FIX) await tx.unsafe(s);
        await tx.unsafe('SET LOCAL ROLE bydp_app');
        [counts] = await tx.unsafe(ANON);
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    // 0013 起函数返回值增加 identityBlocks / descriptionsOverwritten / evidenceDeleted / evidenceKeys（0012 的键保持不变）
    expect((counts as { bydp_anonymize_user: unknown }).bydp_anonymize_user).toMatchObject({
      pointsReversed: 500, bindingsRevoked: 1, identities: 1, preferences: 1, subscriptions: 1, notifications: 1, roles: 1,
    });
    // 余额为 0：不写冲销行
    expect(await attemptSteps([...ANON_FIX.filter((s) => !s.includes('pe_anon')), '@app', ANON, '@owner', must(`not exists (select 1 from points_event where "userId"='u_anon')`, 'reversal for zero')])).toBeNull();
  });

  it('匿名化之后：同一身份可重新注册、同一账号可重新绑定；未失效时重绑仍唯一冲突；permanent 快照仍拦且保留', async () => {
    expect(await attemptSteps([...ANON_FIX, '@app', ANON, NEW_USER, NEW_IDENTITY])).toBeNull();
    expect(await attemptSteps([...ANON_FIX, '@app', ANON, NEW_USER, NEW_BINDING])).toBeNull();
    expect(await attemptSteps([...ANON_FIX, NEW_USER, NEW_BINDING])).toMatch(/binding_brand_account_hash_uq/);
    const perm = `INSERT INTO "self_exclusion" ("id","userId","period") VALUES ('se_anon','u_anon','permanent')`;
    expect(await attemptSteps([...ANON_FIX, perm, '@app', ANON, NEW_USER, NEW_IDENTITY])).toMatch(/permanently self-excluded/);
    expect(await attemptSteps([...ANON_FIX, perm, '@app', ANON, '@owner', must(`(select count(*) = 1 from self_exclusion where "userId"='u_anon' and "identityHashes" @> array['${H('a')}'])`, 'snapshot lost')])).toBeNull();
  });

  it('通用：新 CHECK 为 NOT VALID；绑定唯一为部分索引；bydp_app 对新列无写权限；函数为 owner 级 SECURITY DEFINER', async () => {
    const [c] = await sql!`select convalidated from pg_constraint where conname = 'points_event_sign'`;
    expect(c!.convalidated).toBe(false);
    const [i] = await sql!`select indexdef from pg_indexes where indexname = 'binding_brand_account_hash_uq'`;
    expect(i!.indexdef).toMatch(/WHERE \("revokedAt" IS NULL\)/);
    const [g] = await sql!`select count(*)::int as "n" from information_schema.column_privileges
                          where grantee = 'bydp_app' and privilege_type <> 'SELECT' and column_name in ('revokedAt', 'anonymizedAt')`;
    expect(g!.n).toBe(0);
    const [f] = await sql!`select prosecdef, pg_get_userbyid(proowner) as "owner", (select tableowner from pg_tables where tablename = 'app_user') as "tableOwner"
                          from pg_proc where proname = 'bydp_anonymize_user'`;
    expect(f!.prosecdef).toBe(true);
    expect(f!.owner).toBe(f!.tableOwner);
  });
});

// ---------------- 迁移 0013（A-016：注销身份封禁 · 已结案原文与标题 · 窄窗串行化 · 互斥 UPDATE 修正）----------------
/** 夹具：用户 + 身份（哈希 a）+ 已联系确认的注销请求；extra 在请求之前执行（owner） */
const fix13 = (u: string, extra: string[] = []) => [
  `INSERT INTO "app_user" ("id","displayName") VALUES ('${u}','测试')`,
  `INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('id_${u}','${u}','telegram','${H('a')}')`,
  ...extra,
  `INSERT INTO "data_request" ("id","userId","kind") VALUES ('dr_${u}','${u}','anonymize')`,
  `UPDATE "data_request" SET "contactChannel"='telegram' WHERE "id"='dr_${u}'`,
];
const anon13 = (u: string) => `SELECT bydp_anonymize_user('${u}','dr_${u}')`;
const REREG = [`INSERT INTO "app_user" ("id","displayName") VALUES ('u_new13','新')`, `INSERT INTO "identity" ("id","userId","provider","providerAccountId") VALUES ('id_new13','u_new13','telegram','${H('a')}')`];
const tempExcl = (u: string) => [`SET LOCAL bydp.allow_backfill = 'on'`, `INSERT INTO "self_exclusion" ("id","userId","period","startsAt") VALUES ('se_${u}','${u}','90', now() - interval '60 days')`];
const closedCase = (u: string, id: string, status: string, pub: string | null) => [
  `INSERT INTO "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","status","publicSummary","publicDescription")
   VALUES ('${id}','br_winner','${u}','delay','标题含姓名 小李',1,'2026-09-20','原文：客服小李 13800001111','${status}',${pub ? 'true' : 'false'},${pub ? `'${pub}'` : 'null'})`,
  `INSERT INTO "evidence" ("id","complaintId","type","sha256","storageKey") VALUES ('ev_${id}','${id}','screenshot','${H('d')}','evidence/${id}/ev_${id}')`,
];

describe.skipIf(!url)('迁移 0013（A-016：注销身份封禁 · 已结案原文与标题 · 窄窗串行化 · 互斥 UPDATE 修正）', () => {
  it('临时排除期内注销：身份写入 identity_block（到 endsAt），同 TG 重新注册被拦；过期封禁不拦；permanent 写永久封禁；无排除不写、可重新注册', async () => {
    expect(
      await attemptSteps([...fix13('u_t13', tempExcl('u_t13')), '@app', anon13('u_t13'), '@owner',
        must(`(select count(*) = 1 from identity_block where "identityHash" = '${H('a')}' and "blockedUntil" = (select "endsAt" from self_exclusion where id='se_u_t13'))`, 'block not written')]),
    ).toBeNull();
    expect(await attemptSteps([...fix13('u_t13', tempExcl('u_t13')), '@app', anon13('u_t13'), ...REREG])).toMatch(/blocked until self-exclusion ends/);
    expect(
      await attemptSteps([...fix13('u_t13'), `INSERT INTO "identity_block" ("id","identityHash","blockedUntil","requestId") VALUES ('ib_x','${H('a')}', now() - interval '1 day','dr_u_t13')`, '@app', anon13('u_t13'), ...REREG]),
    ).toBeNull();
    expect(
      await attemptSteps([...fix13('u_p13', [`INSERT INTO "self_exclusion" ("id","userId","period") VALUES ('se_p13','u_p13','permanent')`]), '@app', anon13('u_p13'), '@owner',
        must(`(select count(*) = 1 from identity_block where "identityHash" = '${H('a')}' and "blockedUntil" is null)`, 'no permanent block')]),
    ).toBeNull();
    expect(await attemptSteps([...fix13('u_n13'), '@app', anon13('u_n13'), '@owner', must(`not exists (select 1 from identity_block)`, 'unexpected block'), ...REREG])).toBeNull();
  });

  it('identity_block 只追加（owner 也拦）；bydp_app 无读写权限', async () => {
    const base = [...fix13('u_t13', tempExcl('u_t13')), '@app', anon13('u_t13'), '@owner'];
    expect(await attemptSteps([...base, `UPDATE "identity_block" SET "blockedUntil" = now()`])).toMatch(/append-only/);
    expect(await attemptSteps([...base, `DELETE FROM "identity_block"`])).toMatch(/append-only/);
    expect(await attempt([`SELECT 1 FROM "identity_block"`], 'bydp_app')).toMatch(/permission denied/);
    expect(await attemptSteps([...fix13('u_t13'), '@app', `INSERT INTO "identity_block" ("id","identityHash","requestId") VALUES ('ib_y','${H('a')}','dr_u_t13')`])).toMatch(/permission denied/);
  });

  it('已结案案件：证据原文删除（哈希不变）；原文覆盖为公开陈述 / 「（已注销）」；E1 未公开案件标题覆盖、已公开保留；返回 evidenceKeys；有未结案 → 函数拒绝', async () => {
    expect(
      await attemptSteps([...fix13('u_c13', closedCase('u_c13', 'cp_c13a', 'resolved', '公开陈述：提款被拒')), '@app', anon13('u_c13'), '@owner',
        must(`(select description = '公开陈述：提款被拒' and title = '标题含姓名 小李' from complaint where id='cp_c13a')`, 'public case wrong'),
        must(`(select "storageKey" is null and "deletedAt" is not null and sha256 = '${H('d')}' from evidence where id='ev_cp_c13a')`, 'evidence wrong')]),
    ).toBeNull();
    // E1 反例：未公开案件的标题已被覆盖
    expect(
      await attemptSteps([...fix13('u_c13', closedCase('u_c13', 'cp_c13b', 'rejected', null)), '@app', anon13('u_c13'), '@owner',
        must(`(select description = '（已注销）' and title = '（已注销）' from complaint where id='cp_c13b')`, 'unpublished case not overwritten')]),
    ).toBeNull();
    let out: unknown;
    await sql!
      .begin(async (tx) => {
        for (const s of fix13('u_c13', closedCase('u_c13', 'cp_c13c', 'exposed', '公开'))) await tx.unsafe(s);
        await tx.unsafe('SET LOCAL ROLE bydp_app');
        [out] = await tx.unsafe(anon13('u_c13'));
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect((out as { bydp_anonymize_user: Record<string, unknown> }).bydp_anonymize_user).toMatchObject({
      evidenceKeys: [{ evidenceId: 'ev_cp_c13c', storageKey: 'evidence/cp_c13c/ev_cp_c13c' }],
      evidenceDeleted: 1,
      descriptionsOverwritten: 1,
      identityBlocks: 0,
    });
    expect(await attemptSteps([...fix13('u_c13', closedCase('u_c13', 'cp_c13d', 'unresolved', null)), '@app', anon13('u_c13')])).toMatch(/open complaints must be closed first/);
  });

  it('complaint.description 写入后不可改：bydp_app / owner / bydp_app 自设参数都拒绝', async () => {
    const upd = `UPDATE "complaint" SET "description" = 'x' WHERE "id" = 'cp_001'`;
    expect(await attempt([upd], 'bydp_app')).toMatch(/description is immutable/);
    expect(await attempt([upd])).toMatch(/description is immutable/);
    expect(await attempt([`SELECT set_config('bydp.anonymize','x',true)`, upd], 'bydp_app')).toMatch(/description is immutable/);
  });

  it('窄窗串行化（两个连接）：注销持锁期间新建投诉 → 等锁；注销提交后 → 被拒「已注销」；新建排除 / 请求 / 绑定同样被拒；未注销用户照常', async () => {
    const sql2 = postgres(url!, { max: 1, onnotice: () => {} });
    const u = `u_conc_${Date.now()}`;
    try {
      await sql!.begin(async (tx) => {
        for (const s of fix13(u)) await tx.unsafe(s.replaceAll(`'${H('a')}'`, `'${H('9')}'`));
      });
      const ins = (id: string) =>
        `INSERT INTO "complaint" ("id","brandId","userId","category","title","amountUsdt","eventDate","description","status") VALUES ('${id}','br_winner','${u}','delay','t',1,'2026-09-20','x','screening')`;
      let waited = '';
      await sql!
        .begin(async (a) => {
          await a.unsafe('SET LOCAL ROLE bydp_app');
          await a.unsafe(anon13(u));
          waited = await sql2
            .begin(async (b) => {
              await b.unsafe(`SET LOCAL lock_timeout = '300ms'`);
              await b.unsafe('SET LOCAL ROLE bydp_app');
              await b.unsafe(ins(`cp_${u}_1`));
            })
            .then(() => 'inserted', (e: Error) => e.message);
          throw ROLLBACK;
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e;
        });
      expect(waited).toMatch(/lock timeout/);
      let after: Promise<string> = Promise.resolve('');
      await sql!.begin(async (a) => {
        await a.unsafe('SET LOCAL ROLE bydp_app');
        await a.unsafe(anon13(u));
        after = sql2
          .begin(async (b) => {
            await b.unsafe('SET LOCAL ROLE bydp_app');
            await b.unsafe(ins(`cp_${u}_2`));
          })
          .then(() => 'inserted', (e: Error) => e.message);
        await new Promise((res) => setTimeout(res, 200));
      });
      expect(await after).toMatch(/anonymized/);
      expect(await attempt([`INSERT INTO "self_exclusion" ("id","userId","period") VALUES ('se_${u}','${u}','30')`])).toMatch(/anonymized/);
      expect(await attempt([`INSERT INTO "data_request" ("id","userId","kind") VALUES ('dr2_${u}','${u}','export')`])).toMatch(/anonymized/);
      expect(
        await attempt([
          `INSERT INTO "user_brand_binding" ("id","userId","brandId","operatorAccountIdHash","operatorAccountIdEnc","operatorAccountIdMasked","source") VALUES ('ubb_${u}','${u}','br_winner','${H('f')}','${ENC}','ab***yz','manual')`,
        ]),
      ).toMatch(/anonymized/);
      expect(await attempt([ins('cp_live').replace(`'${u}'`, `'u_233'`)], 'bydp_app')).toBeNull();
    } finally {
      await sql2.end();
    }
  });

  it('互斥触发器 UPDATE 修正：单行 arbitrator → commerce 通过；带其他行改成冲突角色仍拦；插入冲突仍拦', async () => {
    expect(await attemptSteps([`INSERT INTO "user_role" VALUES ('u_233','arbitrator')`, '@app', `UPDATE "user_role" SET "roleKey"='commerce' WHERE "userId"='u_233'`])).toBeNull();
    expect(
      await attemptSteps([`INSERT INTO "user_role" VALUES ('u_233','arbitrator')`, `INSERT INTO "user_role" VALUES ('u_233','editor')`, '@app',
        `UPDATE "user_role" SET "roleKey"='commerce' WHERE "userId"='u_233' AND "roleKey"='editor'`]),
    ).toMatch(/mutually exclusive/);
    expect(await attemptSteps([`INSERT INTO "user_role" VALUES ('u_233','arbitrator')`, '@app', `INSERT INTO "user_role" VALUES ('u_233','commerce')`])).toMatch(/mutually exclusive/);
  });

  it('通用：identity_block createdAt 两个触发器；四个锁触发器', async () => {
    const [t] = await sql!`select count(*)::int as "n" from pg_trigger where tgname in ('identity_block_created_at_server_ts','identity_block_created_at_immutable')`;
    expect(t!.n).toBe(2);
    const [l] = await sql!`select string_agg(tgname, ',' order by tgname) as "t" from pg_trigger where tgname like '%lock_live_user'`;
    expect(l!.t).toBe('binding_lock_live_user,complaint_lock_live_user,data_request_lock_live_user,self_exclusion_lock_live_user');
  });
});

// ---------------- 迁移 0014（A-017：Agent 专用角色 · 站点监控记录 · Candidate 去刷计数 · 品牌属性来源）----------------
describe.skipIf(!url)('迁移 0014（A-017：bydp_agent · site_check · candidate_query · 品牌属性来源）', () => {
  const AG = 'bydp_agent';
  it('bydp_agent：可登录、非超级用户；只读规则所需列；读不到身份 / 联系方式 / 投诉自由文本 / 资金 / 新身份封禁表', async () => {
    const [role] = await sql!`select rolcanlogin, rolsuper, rolcreaterole from pg_roles where rolname = 'bydp_agent'`;
    expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolcreaterole: false });
    for (const s of [
      `SELECT id, value, online FROM "identifier" LIMIT 1`,
      `SELECT id, slug, name, status FROM "brand" LIMIT 1`,
      `SELECT id, "brandId", "userId", category, "amountUsdt", "eventDate", status, "createdAt" FROM "complaint" LIMIT 1`,
      `SELECT "userId", fingerprint FROM "device" LIMIT 1`,
      `SELECT 1 FROM "brand_attribute" LIMIT 1`,
      `SELECT 1 FROM "content" LIMIT 1`,
      `SELECT 1 FROM "review_item" LIMIT 1`,
    ])
      expect(await attempt([s], AG)).toBeNull();
    for (const s of [`SELECT "certifiedDepositUsdt" FROM "brand"`, `SELECT description FROM "complaint"`, `SELECT title FROM "complaint"`])
      expect(await attempt([s], AG)).toMatch(/permission denied/);
    for (const t of ['identity', 'app_user', 'user_brand_binding', 'evidence', 'notification', 'audit_log', 'click', 'commission', 'data_request', 'identity_block', 'candidate_query'])
      expect(await attempt([`SELECT 1 FROM "${t}" LIMIT 1`], AG)).toMatch(/permission denied/);
  });

  it('bydp_agent 只能新建待决提议与站点记录；不能做决定、不能直接改品牌 / 标识 / 属性 / 投诉 / 内容', async () => {
    const ri = `INSERT INTO "review_item" ("id","kind","subject","proposal","source") VALUES ('ri_a','site_monitor','idf_001','{"type":"offline"}','site-monitor@0.1')`;
    expect(await attempt([ri, must(`(select status = 'pending' from review_item where id='ri_a')`, 'not pending')], AG)).toBeNull();
    expect(await attempt([`INSERT INTO "review_item" ("id","kind","subject","proposal","source","status") VALUES ('ri_b','site_monitor','x','{}','a','approved')`], AG)).toMatch(/permission denied/);
    expect(await attempt([ri, `UPDATE "review_item" SET "status"='approved' WHERE "id"='ri_a'`], AG)).toMatch(/permission denied/);
    for (const s of [
      `UPDATE "identifier" SET "online" = false`,
      `INSERT INTO "brand_attribute" ("brandId","dimension","values","source") VALUES ('br_winner','pay','{x}','agent')`,
      `UPDATE "complaint" SET "status" = 'rejected'`,
      `UPDATE "brand" SET "status" = 'blacklist'`,
      `UPDATE "content" SET "title" = 'x'`,
      `SELECT bydp_anonymize_user('u_233','dr_x')`,
    ])
      expect(await attempt([s], AG)).toMatch(/permission denied/);
  });

  it('site_check：Agent 写入取服务端时间；Agent 不能改 / 删，owner 改被拦；bydp_app 可清理；结果二选一、kind 白名单', async () => {
    const sc = `INSERT INTO "site_check" ("id","identifierId","kind","url","httpStatus","finalHost","contentHash","checkedAt") VALUES ('sc_1','idf_001','home','https://jinlong88.com/',301,'jl-new.com','${'c'.repeat(64)}','2020-01-01')`;
    expect(await attempt([sc, must(`(select "checkedAt" > now() - interval '1 minute' from site_check where id='sc_1')`, 'forged time kept')], AG)).toBeNull();
    expect(await attempt([sc, `UPDATE "site_check" SET "httpStatus" = 200`], AG)).toMatch(/permission denied/);
    expect(await attempt([sc, `DELETE FROM "site_check"`], AG)).toMatch(/permission denied/);
    expect(await attempt([sc, `UPDATE "site_check" SET "httpStatus" = 200`])).toMatch(/append-only/);
    expect(await attempt([sc, `SET LOCAL ROLE bydp_app`, `DELETE FROM "site_check"`])).toBeNull();
    expect(await attempt([`INSERT INTO "site_check" ("id","identifierId","kind","url","httpStatus") VALUES ('sc_2','idf_001','login','u',200)`], AG)).toMatch(/site_check_kind/);
    expect(await attempt([`INSERT INTO "site_check" ("id","identifierId","kind","url","httpStatus","error") VALUES ('sc_2','idf_001','home','u',200,'x')`], AG)).toMatch(/site_check_outcome/);
    expect(await attempt([`INSERT INTO "site_check" ("id","identifierId","kind","url") VALUES ('sc_2','idf_001','home','u')`], AG)).toMatch(/site_check_outcome/);
    expect(await attempt([`INSERT INTO "site_check" ("id","identifierId","kind","url","error") VALUES ('sc_2','idf_001','home','u','timeout')`], AG)).toBeNull();
  });

  it('candidate_query：同一查询者同一天只计 1；写入后不可改（owner 也拦）；只存 64 位哈希；weightedPriority 可容纳计数', async () => {
    const cand = `INSERT INTO "candidate" ("id","identifierType","value","firstQueried") VALUES ('cand_t','domain','unknown-x.com',current_date)`;
    const cq = (id: string, v: string) => `INSERT INTO "candidate_query" ("id","candidateId","viewerHash","day") VALUES ('${id}','cand_t','${v.repeat(64)}',current_date)`;
    expect(await attempt([cand, `SET LOCAL ROLE bydp_app`, cq('cq_1', 'a'), cq('cq_2', 'b')])).toBeNull();
    expect(await attempt([cand, `SET LOCAL ROLE bydp_app`, cq('cq_1', 'a'), cq('cq_2', 'a')])).toMatch(/candidate_query_viewer_day_uq/);
    expect(await attempt([cand, `SET LOCAL ROLE bydp_app`, cq('cq_1', 'a'), `UPDATE "candidate_query" SET "day" = current_date - 1`])).toMatch(/permission denied/);
    expect(await attempt([cand, cq('cq_1', 'a'), `UPDATE "candidate_query" SET "day" = current_date - 1`])).toMatch(/append-only/);
    expect(await attempt([cand, `INSERT INTO "candidate_query" ("id","candidateId","viewerHash","day") VALUES ('cq_x','cand_t','203.0.113.5',current_date)`])).toMatch(/candidate_query_viewer_hex/);
    expect(await attempt([cand, `UPDATE "candidate" SET "weightedPriority" = 12345.5 WHERE "id"='cand_t'`], 'bydp_app')).toBeNull();
  });

  it('brand_attribute 来源列只能随 source = agent；新表 createdAt 触发器齐全', async () => {
    expect(
      await attempt([`INSERT INTO "brand_attribute" ("brandId","dimension","values","source","sourceUrl","sourceFetchedAt","reviewItemId") VALUES ('br_winner','pay_x','{USDT}','agent','https://x/pay',now(),'ri_x')`], 'bydp_app'),
    ).toBeNull();
    expect(await attempt([`INSERT INTO "brand_attribute" ("brandId","dimension","values","source","sourceUrl") VALUES ('br_winner','pay_y','{USDT}','human','https://x/pay')`], 'bydp_app')).toMatch(
      /brand_attribute_source_url_agent/,
    );
    const [t] = await sql!`select count(*)::int as "n" from pg_trigger where tgname in ('candidate_query_created_at_server_ts','candidate_query_created_at_immutable','site_check_created_at_server_ts','site_check_created_at_immutable')`;
    expect(t!.n).toBe(4);
  });
});

// ---------------- 迁移 0015（A-018 v2：Offer 独立上下线状态 · 关联方永不认证 DB 兜底）----------------
describe.skipIf(!url)('迁移 0015（A-018：offer.status · 关联方永不认证 · 黑名单连带下线）', () => {
  /** 返回约束名（触发器 RAISE … CONSTRAINT）或 null（成功） */
  async function constraintOf(stmts: string[], role?: string): Promise<string | null> {
    try {
      await sql!.begin(async (tx) => {
        if (role) await tx.unsafe(`SET LOCAL ROLE ${role}`);
        for (const s of stmts) await tx.unsafe(s);
        throw ROLLBACK;
      });
      return null;
    } catch (e) {
      return e === ROLLBACK ? null : ((e as { constraint_name?: string }).constraint_name ?? `ERR ${(e as Error).message}`);
    }
  }
  const REL = 'brand_related_party_never_certified';
  const OFF = 'offer_blacklisted_brand_inactive';

  it('结构：offer.status 枚举 active / offline，默认 active、非空；四个触发器在位', async () => {
    const [col] = await sql!`select udt_name, column_default, is_nullable from information_schema.columns where table_name = 'offer' and column_name = 'status'`;
    expect(col).toEqual({ udt_name: 'offer_status', column_default: "'active'::offer_status", is_nullable: 'NO' });
    const t = await sql!`select tgname from pg_trigger where tgname in ('brand_certify_guard','operator_related_guard','brand_blacklist_offer_offline','offer_active_guard') order by 1`;
    expect(t.map((r) => r.tgname)).toEqual(['brand_blacklist_offer_offline', 'brand_certify_guard', 'offer_active_guard', 'operator_related_guard']);
  });

  it('#26 关联方永不认证（owner 与 bydp_app 同样拦，命名约束）；非关联方可认证、关联方可转黑名单', async () => {
    expect(await constraintOf([`UPDATE brand SET status = 'certified' WHERE id = 'br_crown'`])).toBe(REL);
    expect(await constraintOf([`UPDATE brand SET status = 'certified' WHERE id = 'br_crown'`], 'bydp_app')).toBe(REL);
    expect(await constraintOf([`UPDATE brand SET "operatorId" = (SELECT "operatorId" FROM brand WHERE id = 'br_crown') WHERE id = 'br_jinlong'`])).toBe(REL);
    expect(await constraintOf([`UPDATE operator SET "relatedParty" = true WHERE id = (SELECT "operatorId" FROM brand WHERE id = 'br_jinlong')`])).toBe(REL);
    expect(await constraintOf([`UPDATE brand SET status = 'certified' WHERE id = 'br_longteng'`])).toBeNull();
    expect(await constraintOf([`UPDATE operator SET "relatedParty" = true WHERE id = (SELECT "operatorId" FROM brand WHERE id = 'br_longteng')`])).toBeNull();
    expect(await constraintOf([`UPDATE brand SET status = 'blacklist' WHERE id = 'br_crown'`])).toBeNull();
  });

  it('Offer：转黑名单同事务全部下线、解除不自动恢复、人工可重新上线；黑名单期间上线 / 新建 active / 改挂均拒绝；其他 check_violation 不带我方约束名', async () => {
    expect(await attempt([`UPDATE brand SET status = 'blacklist' WHERE id = 'br_jinlong'`, must(`(select count(*) from offer where "brandId" = 'br_jinlong' and status = 'active') = 0`, 'not offline')], 'bydp_app')).toBeNull();
    expect(
      await attempt([
        `UPDATE brand SET status = 'blacklist' WHERE id = 'br_jinlong'`,
        `UPDATE brand SET status = 'watch' WHERE id = 'br_jinlong'`,
        must(`(select count(*) from offer where "brandId" = 'br_jinlong' and status = 'active') = 0`, 'auto-restored'),
        `UPDATE offer SET status = 'active' WHERE "brandId" = 'br_jinlong'`,
      ]),
    ).toBeNull();
    expect(await constraintOf([`UPDATE brand SET status = 'blacklist' WHERE id = 'br_jinlong'`, `UPDATE offer SET status = 'active' WHERE "brandId" = 'br_jinlong'`])).toBe(OFF);
    expect(await constraintOf([`INSERT INTO offer (id, "brandId", title, type, terms, "trueValue") VALUES ('of_g15', 'br_caishen', 'x', 'deposit', '{}', '{}')`], 'bydp_app')).toBe(OFF);
    expect(await constraintOf([`INSERT INTO offer (id, "brandId", title, type, terms, "trueValue", status) VALUES ('of_g15', 'br_caishen', 'x', 'deposit', '{}', '{}', 'offline')`])).toBeNull();
    expect(await constraintOf([`UPDATE offer SET "brandId" = 'br_caishen' WHERE id = 'of_001'`])).toBe(OFF);
    expect(await constraintOf([`UPDATE brand SET "redirectTemplate" = 'http://bad' WHERE id = 'br_jinlong'`])).not.toMatch(new RegExp(`^(${REL}|${OFF})$`));
  });

  it('权限不变：scoring_ro / bydp_agent 读不到 offer', async () => {
    expect(await attempt([`SELECT 1 FROM offer LIMIT 1`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    expect(await attempt([`SELECT 1 FROM offer LIMIT 1`], 'bydp_agent')).toMatch(/permission denied/);
  });
});

// ---------------- 迁移 0016（A-019 v2：评价 / 出款凭证提交与审核）----------------
describe.skipIf(!url)('迁移 0016（A-019：提交强制待审 · 绑定与限额 · F8 未来时间 · 判定单向 · trustWeight 由库写入）', () => {
  /** 返回约束名（触发器 / CHECK）、'ERR …'（其他错误）或 null（成功）；末条为 SELECT 时可取结果 */
  async function run(stmts: string[], role?: string): Promise<{ err: string | null; rows: Record<string, unknown>[] }> {
    let rows: Record<string, unknown>[] = [];
    try {
      await sql!.begin(async (tx) => {
        if (role) await tx.unsafe(`SET LOCAL ROLE ${role}`);
        for (const s of stmts) rows = (await tx.unsafe(s)) as unknown as Record<string, unknown>[];
        throw ROLLBACK;
      });
      return { err: null, rows };
    } catch (e) {
      if (e === ROLLBACK) return { err: null, rows };
      return { err: (e as { constraint_name?: string }).constraint_name ?? `ERR ${(e as Error).message}`, rows };
    }
  }
  const APP = 'bydp_app';
  // seed：ubb_002 = u_233 · br_winner · 自报级 · boundAt 2026-08-14；ubb_004 = u_412 · br_crown · 回传确认
  const WR = (id: string, req: string, rec: string | null = null, amount = 100, outcome = 'pending') =>
    `INSERT INTO withdrawal_report (id, "brandId", kind, "amountUsdt", method, "requestedAt", "receivedAt", outcome, "bindingId", "userId")
     VALUES ('${id}', 'br_winner', 'user', ${amount}, 'USDT-TRC20', ${req}, ${rec ?? 'NULL'}, '${outcome}', 'ubb_002', 'u_233')`;
  const AGO = (d: number) => `now() - interval '${d} days'`;

  it('结构：存量凭证 accepted、评价 published；9 个触发器在位', async () => {
    const [s] = await sql!`select (select count(*) from withdrawal_report where status <> 'accepted')::int as "w", (select count(*) from review where status <> 'published')::int as "r"`;
    expect(s).toEqual({ w: 0, r: 0 });
    const [t] = await sql!`select count(*)::int as "n" from pg_trigger where tgname in ('withdrawal_report_submit_guard','withdrawal_report_update_guard','review_submit_guard','review_update_guard','submission_evidence_insert_guard','submission_evidence_server_ts','submission_evidence_guard_update','submission_evidence_no_delete','submission_evidence_no_truncate')`;
    expect(t!.n).toBe(9);
  });

  it('凭证：应用写入一律 pending（传 accepted 也无效）；无绑定 / 绑定晚于申请被拒', async () => {
    const ok = await run([WR('wr_g1', AGO(1)).replace('"userId")', '"userId", status)').replace(`'u_233')`, `'u_233', 'accepted')`), `SELECT status FROM withdrawal_report WHERE id = 'wr_g1'`], APP);
    expect(ok).toEqual({ err: null, rows: [{ status: 'pending' }] });
    expect((await run([WR('wr_g2', AGO(1)).replace(`'ubb_002'`, 'NULL')], APP)).err).toBe('withdrawal_report_binding_required');
    expect((await run([WR('wr_g3', `'2026-08-01'`)], APP)).err).toBe('withdrawal_report_binding_after_request');
  });

  it('F8：申报时间 / 到账时间不得在未来（10 分钟容差），插入与补录同口径；回填路径不受影响', async () => {
    expect((await run([WR('wr_f1', `now() + interval '1 day'`)], APP)).err).toBe('withdrawal_report_time_in_future');
    expect((await run([WR('wr_f2', AGO(1), `now() + interval '9 days'`, 100, 'paid')], APP)).err).toBe('withdrawal_report_time_in_future');
    expect((await run([WR('wr_f3', `now() + interval '5 minutes'`)], APP)).err).toBeNull();
    expect((await run([WR('wr_f4', AGO(2)), `UPDATE withdrawal_report SET outcome = 'paid', "receivedAt" = now() + interval '9 days' WHERE id = 'wr_f4'`], APP)).err).toBe(
      'withdrawal_report_time_in_future',
    );
    expect((await run([WR('wr_f5', AGO(2)), `UPDATE withdrawal_report SET outcome = 'paid', "receivedAt" = now() WHERE id = 'wr_f5'`], APP)).err).toBeNull();
    expect((await run([`SET LOCAL bydp.allow_backfill = 'on'`, `INSERT INTO withdrawal_report (id, "brandId", kind, "amountUsdt", method, "requestedAt", outcome) VALUES ('wr_f6', 'br_winner', 'official', 1, 'x', now() + interval '1 day', 'pending')`])).err).toBeNull();
  });

  it('CHECK：金额须 > 0；评价 ≤ 500 字（中文按字计）', async () => {
    expect((await run([WR('wr_k1', AGO(1), null, 0)], APP)).err).toBe('withdrawal_report_amount_positive');
    const rv = (n: number) => `INSERT INTO review (id, "brandId", "userId", rating, text, "bindingId") VALUES ('rv_k${n}', 'br_crown', 'u_412', 4, '${'评'.repeat(n)}', 'ubb_004')`;
    expect((await run([rv(501)], APP)).err).toBe('review_text_len');
    expect((await run([rv(500)], APP)).err).toBeNull();
  });

  it('写入端限额：同一绑定前后 30 天内第 4 条被拒；驳回的不占额度', async () => {
    const three = [WR('wr_l1', AGO(1)), WR('wr_l2', AGO(10)), WR('wr_l3', AGO(20))];
    expect((await run([...three, WR('wr_l4', AGO(25))], APP)).err).toBe('withdrawal_report_binding_limit');
    expect(
      (await run([...three, `UPDATE withdrawal_report SET status = 'rejected', "decidedBy" = 'arb', "rejectReason" = '无截图' WHERE id = 'wr_l3'`, WR('wr_l4', AGO(25))], APP)).err,
    ).toBeNull();
  });

  it('判定单向、核心列锁死（owner 同样）；驳回须原因', async () => {
    const one = [WR('wr_d1', AGO(1))];
    expect((await run([...one, `UPDATE withdrawal_report SET status = 'accepted', "decidedBy" = 'arb' WHERE id = 'wr_d1'`, `UPDATE withdrawal_report SET status = 'rejected', "rejectReason" = 'x' WHERE id = 'wr_d1'`], APP)).err).toBe(
      'withdrawal_report_decision_final',
    );
    expect((await run([...one, `UPDATE withdrawal_report SET status = 'rejected', "decidedBy" = 'arb' WHERE id = 'wr_d1'`], APP)).err).toBe('withdrawal_report_decision_fields');
    expect((await run([...one, `RESET ROLE`, `UPDATE withdrawal_report SET "amountUsdt" = 1 WHERE id = 'wr_d1'`], APP)).err).toBe('withdrawal_report_immutable');
  });

  it('评价：须本人绑定；trustWeight / verifiedBinding 由库写入（回传确认 = 1.0）；同品牌第二条被拒；应用不可删', async () => {
    const rv = (id: string, extra = '') => `INSERT INTO review (id, "brandId", "userId", rating, text, "bindingId"${extra ? ', "trustWeight"' : ''}) VALUES ('${id}', 'br_crown', 'u_412', 4, 't', 'ubb_004'${extra})`;
    expect(await run([rv('rv_w1', ', 0.2'), `SELECT status, "trustWeight", "verifiedBinding" FROM review WHERE id = 'rv_w1'`], APP)).toEqual({
      err: null,
      rows: [{ status: 'pending', trustWeight: '1.00', verifiedBinding: true }],
    });
    expect((await run([`INSERT INTO review (id, "brandId", "userId", rating, "bindingId") VALUES ('rv_w2', 'br_crown', 'u_233', 4, 'ubb_004')`], APP)).err).toBe('review_binding_required');
    expect((await run([rv('rv_w3'), rv('rv_w4')], APP)).err).toBe('review_user_brand_active_uq');
    expect(await attempt([`DELETE FROM review WHERE id = 'rv_001'`], APP)).toMatch(/permission denied/);
    expect((await run([`UPDATE review SET text = '改' WHERE id = 'rv_001'`])).err).toBe('review_immutable');
  });

  it('权限：scoring_ro 可读 status、不可读 submission_evidence；截图只能挂在待审用户凭证上', async () => {
    expect(await attempt([`SELECT status FROM withdrawal_report LIMIT 1`, `SELECT status FROM review LIMIT 1`], 'bydp_scoring_ro')).toBeNull();
    expect(await attempt([`SELECT 1 FROM submission_evidence LIMIT 1`], 'bydp_scoring_ro')).toMatch(/permission denied/);
    const ev = (report: string) => `INSERT INTO submission_evidence (id, "withdrawalReportId", sha256, mime, bytes, "storageKey") VALUES ('se_${report}', '${report}', '${'1'.repeat(64)}', 'image/png', 10, 'se/x')`;
    expect((await run([WR('wr_e1', AGO(1)), ev('wr_e1')], APP)).err).toBeNull();
    expect((await run([ev('wr_001')], APP)).err).toBe('submission_evidence_report_pending');
  });
});
