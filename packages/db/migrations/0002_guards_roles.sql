-- 只追加约束（.claude/rules/db-migration.md · 架构 §7 信任域）
-- 触发器层：即使以表 owner 连接也生效；权限层见 20_roles.sql。

CREATE OR REPLACE FUNCTION bydp_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %: append-only table', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- status_history / audit_log：禁止 UPDATE / DELETE / TRUNCATE
DROP TRIGGER IF EXISTS status_history_append_only ON "status_history";
CREATE TRIGGER status_history_append_only BEFORE UPDATE OR DELETE ON "status_history"
  FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();
DROP TRIGGER IF EXISTS status_history_no_truncate ON "status_history";
CREATE TRIGGER status_history_no_truncate BEFORE TRUNCATE ON "status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();

DROP TRIGGER IF EXISTS audit_log_append_only ON "audit_log";
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON "audit_log";
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();

-- evidence：禁止 DELETE / TRUNCATE；UPDATE 仅允许原文侧列（storageKey / redacted / redactedAt / deletedAt）
CREATE OR REPLACE FUNCTION bydp_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."complaintId" IS DISTINCT FROM OLD."complaintId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."label" IS DISTINCT FROM OLD."label"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."txHash" IS DISTINCT FROM OLD."txHash"
     OR NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt" THEN
    RAISE EXCEPTION 'evidence: hash record is append-only (only storageKey/redacted/redactedAt/deletedAt may change)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 脱敏 / 删除不可逆
  IF OLD."redacted" AND NOT NEW."redacted" THEN
    RAISE EXCEPTION 'evidence: redaction is irreversible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."deletedAt" IS NOT NULL AND (NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" OR NEW."storageKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'evidence: deletion is irreversible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 删除必须同时清空原文对象
  IF NEW."deletedAt" IS NOT NULL AND NEW."storageKey" IS NOT NULL THEN
    RAISE EXCEPTION 'evidence: deleted evidence must not reference an object' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 已脱敏后原文对象只能被清空（删除），不能改指向
  IF OLD."redacted" AND NEW."storageKey" IS NOT NULL AND NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
    RAISE EXCEPTION 'evidence: redacted evidence object cannot be re-pointed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evidence_guard_update ON "evidence";
CREATE TRIGGER evidence_guard_update BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_evidence_guard();
-- 证据原文删除：不删行，置 deletedAt + storageKey = NULL（哈希保留）
DROP TRIGGER IF EXISTS evidence_no_delete ON "evidence";
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();
DROP TRIGGER IF EXISTS evidence_no_truncate ON "evidence";
CREATE TRIGGER evidence_no_truncate BEFORE TRUNCATE ON "evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();

-- user_brand_binding：绑定身份不可改（P3 "纠纷前绑定" 依据；A-001 M1）
-- boundAt / userId / brandId / operatorAccountId / operatorAccountIdHash / source 一经写入不可改；账号填错 = 新建绑定。
CREATE OR REPLACE FUNCTION bydp_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."boundAt" IS DISTINCT FROM OLD."boundAt" THEN
    RAISE EXCEPTION 'user_brand_binding.boundAt is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."brandId" IS DISTINCT FROM OLD."brandId"
     OR NEW."operatorAccountId" IS DISTINCT FROM OLD."operatorAccountId" OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."operatorAccountIdHash" IS DISTINCT FROM OLD."operatorAccountIdHash" THEN
    RAISE EXCEPTION 'user_brand_binding: userId/brandId/operatorAccountId/operatorAccountIdHash/source are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS binding_guard_update ON "user_brand_binding";
CREATE TRIGGER binding_guard_update BEFORE UPDATE ON "user_brand_binding"
  FOR EACH ROW EXECUTE FUNCTION bydp_binding_guard();

-- 服务端时间戳（I1）：以下列在 INSERT 时一律取 DB 时间，应用层传值被覆盖。
-- 例外：seed / 历史导入须同时满足 ①以表 owner 身份执行 ②SET LOCAL bydp.allow_backfill = 'on'。
-- 自定义 GUC 任何角色都能 SET，故以 owner 身份为真正闸门；bydp_app / bydp_scoring_ro 永远走服务端时间。
CREATE OR REPLACE FUNCTION bydp_server_ts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text := TG_ARGV[0];
BEGIN
  IF coalesce(current_setting('bydp.allow_backfill', true), 'off') = 'on'
     AND current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = TG_TABLE_SCHEMA AND tablename = TG_TABLE_NAME) THEN
    RETURN NEW;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(col, now()));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS binding_server_ts ON "user_brand_binding";
CREATE TRIGGER binding_server_ts BEFORE INSERT ON "user_brand_binding"
  FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('boundAt');
DROP TRIGGER IF EXISTS status_history_server_ts ON "status_history";
CREATE TRIGGER status_history_server_ts BEFORE INSERT ON "status_history"
  FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('at');
DROP TRIGGER IF EXISTS audit_log_server_ts ON "audit_log";
CREATE TRIGGER audit_log_server_ts BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('at');
DROP TRIGGER IF EXISTS evidence_server_ts ON "evidence";
CREATE TRIGGER evidence_server_ts BEFORE INSERT ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('uploadedAt');

-- M2（A-001）：所有带 createdAt 的表 + conversion.receivedAt 一律服务端时间。
-- 用户申报的业务时间（withdrawal requestedAt/receivedAt、complaint.eventDate、conversion.occurredAt）不在此列。
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'createdAt' ORDER BY table_name LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.table_name || '_created_at_server_ts', r.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION bydp_server_ts(%L)',
                   r.table_name || '_created_at_server_ts', r.table_name, 'createdAt');
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS conversion_received_at_server_ts ON "conversion";
CREATE TRIGGER conversion_received_at_server_ts BEFORE INSERT ON "conversion"
  FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('receivedAt');

-- R1（A-001）：品牌 / 案件状态变更自动写 status_history（§5：所有状态变更只追加、可审计）。
-- 应用层以 SET LOCAL bydp.actor / bydp.status_reason 传入操作者与理由；未设置时 actor = 当前 DB 角色。
CREATE OR REPLACE FUNCTION bydp_log_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor text := coalesce(nullif(current_setting('bydp.actor', true), ''), current_user);
  reason text := nullif(current_setting('bydp.status_reason', true), '');
BEGIN
  IF TG_TABLE_NAME = 'brand' THEN
    INSERT INTO "status_history" ("brandId", "from", "to", "reason", "actor")
      VALUES (NEW."id", OLD."status"::text, NEW."status"::text, reason, actor);
  ELSE
    INSERT INTO "status_history" ("complaintId", "from", "to", "reason", "actor")
      VALUES (NEW."id", OLD."status"::text, NEW."status"::text, reason, actor);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brand_status_log ON "brand";
CREATE TRIGGER brand_status_log AFTER UPDATE OF "status" ON "brand"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION bydp_log_status();
DROP TRIGGER IF EXISTS complaint_status_log ON "complaint";
CREATE TRIGGER complaint_status_log AFTER UPDATE OF "status" ON "complaint"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION bydp_log_status();

-- M2b（A-001 复审）：服务端时间写入后不可改（owner 同样拦）。
CREATE OR REPLACE FUNCTION bydp_immutable_col() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text := TG_ARGV[0];
BEGIN
  IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
    RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, col USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'createdAt' ORDER BY table_name LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.table_name || '_created_at_immutable', r.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bydp_immutable_col(%L)',
                   r.table_name || '_created_at_immutable', r.table_name, 'createdAt');
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS conversion_received_at_immutable ON "conversion";
CREATE TRIGGER conversion_received_at_immutable BEFORE UPDATE ON "conversion"
  FOR EACH ROW EXECUTE FUNCTION bydp_immutable_col('receivedAt');

-- 审核非阻塞备注：brand.statusSince 只随 status 变更、由服务端取当天日期；不可单独改。
CREATE OR REPLACE FUNCTION bydp_brand_status_since() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    NEW."statusSince" := current_date;
  ELSIF NEW."statusSince" IS DISTINCT FROM OLD."statusSince" THEN
    RAISE EXCEPTION 'brand.statusSince changes only with status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brand_status_since ON "brand";
CREATE TRIGGER brand_status_since BEFORE UPDATE ON "brand"
  FOR EACH ROW EXECUTE FUNCTION bydp_brand_status_since();
-- 数据库角色与授权（ADR-0006）。每次新增迁移须同步维护本文件（rules/db-migration.md）。
-- 密码不入库：运维以 ALTER ROLE ... PASSWORD 在带外设置（本地开发见 scripts/dev-db.sh）。

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bydp_app') THEN CREATE ROLE bydp_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bydp_scoring_ro') THEN CREATE ROLE bydp_scoring_ro LOGIN; END IF;
END $$;

-- ------------------------------------------------------------------
-- bydp_app：业务运行角色（web / api / worker 经 packages/core）
-- ------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO bydp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bydp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bydp_app;
-- 注意：上行对"所有表"授权——每新增一张只追加表，必须在此追加对应 REVOKE（rules/db-migration.md）
-- 只追加表：收回 UPDATE / DELETE / TRUNCATE
REVOKE UPDATE, DELETE, TRUNCATE ON "status_history", "audit_log" FROM bydp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "evidence" FROM bydp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "exposure_complaint" FROM bydp_app;
GRANT UPDATE ("storageKey", "redacted", "redactedAt", "deletedAt") ON "evidence" TO bydp_app;
-- 绑定：身份列（boundAt / userId / brandId / operatorAccountId / operatorAccountIdHash / source）不可改（列级收回 + 触发器，A-001 M1）
REVOKE UPDATE ON "user_brand_binding" FROM bydp_app;
GRANT UPDATE ("verificationLevel", "postbackAt", "compensationEligible", "promoCodeId", "updatedAt")
  ON "user_brand_binding" TO bydp_app;
REVOKE DELETE ON "user_brand_binding" FROM bydp_app;
-- R2（A-001）：信任域记录不可删；评分快照即历史，不可改
REVOKE DELETE, TRUNCATE ON "exposure", "complaint", "operator_reply", "withdrawal_report", "score_snapshot" FROM bydp_app;
REVOKE UPDATE ON "score_snapshot" FROM bydp_app;
-- 服务端时间戳：bydp_app 非表 owner，回填开关对其无效（见 10_append_only.sql bydp_server_ts）

-- ------------------------------------------------------------------
-- bydp_scoring_ro：评分 / 排序引擎只读角色（ADR-0006 第 ③ 层）
-- 白名单制：只 GRANT 评分因子所需的信任域 + 运营商域（非商业）表；
-- 商业域（offer / promo_code / click / conversion / commission / partner / affiliate_complaint）、
-- 担保域、用户身份域一律不授权。评分写回 score_snapshot 由 worker 以 bydp_app 执行。
-- ------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bydp_scoring_ro;
GRANT USAGE ON SCHEMA public TO bydp_scoring_ro;
GRANT SELECT ON
  "operator", "identifier", "entity_link", "license", "brand_attribute", "candidate", -- 运营商域：硬指标 / 稳定性 / 关联风险（ADR-0006 v1.3 白名单含 Candidate）
  "status_history", "score_snapshot", "operator_reply", "exposure", "exposure_complaint" -- 信任域
TO bydp_scoring_ro;
-- brand：不含 certifiedDepositUsdt（保证金属担保 / 认证门槛，不是评分输入）
GRANT SELECT ("id", "operatorId", "slug", "name", "status", "statusSince", "logoUrl", "markets", "hasActiveExposure", "createdAt", "updatedAt")
  ON "brand" TO bydp_scoring_ro;
-- 出款因子：withdrawal_report 不含 bindingId（用户假名关联）
GRANT SELECT ("id", "brandId", "kind", "amountUsdt", "method", "requestedAt", "receivedAt", "outcome", "complaintId", "createdAt")
  ON "withdrawal_report" TO bydp_scoring_ro;
-- 仲裁履约因子：complaint 仅列级授权（不含 userId / bindingId / description）
GRANT SELECT ("id", "brandId", "category", "amountUsdt", "status", "publicSummary", "createdAt", "acceptedAt",
  "operatorNotifiedAt", "secondNoticeAt", "replyDeadline", "operatorRepliedAt", "resolvedAt", "exposedAt")
  ON "complaint" TO bydp_scoring_ro;
-- 玩家评价因子：review 仅列级授权（不含 userId / text）
GRANT SELECT ("id", "brandId", "rating", "trustWeight", "verifiedBinding", "helpful", "createdAt") ON "review" TO bydp_scoring_ro;
-- 纵深防御（非主防线，会话可关闭）；主防线是上面的白名单 GRANT：新表默认对 scoring 不可见
ALTER ROLE bydp_scoring_ro SET default_transaction_read_only = on;
