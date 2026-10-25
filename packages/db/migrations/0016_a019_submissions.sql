-- A-019 迁移 0016 预览 v2（双签 db，未落地；落地时原样写入 packages/db/migrations/0016_a019_submissions.sql）
-- 依据：D-024 方案 · W3#073 裁定（trustWeight 四档 / 凭证必附截图 / 评价入口 / 评价文字不公开）与补充 1（限额先锁绑定行）、补充 2（注销覆盖新表）
-- v1 → v2（审核 W2#002）：F8 未来时间——非回填路径的申报时间不得晚于 now() + 10 分钟（插入与 outcome 补录）；
--          CHECK withdrawal_report_amount_positive（金额 > 0）、review_text_len（评价 ≤ 500 字）
-- 生成部分（drizzle-kit generate，未改动）：下面到「手写部分」之前的全部语句
CREATE TYPE "public"."submission_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'published', 'rejected');--> statement-breakpoint
CREATE TABLE "submission_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"withdrawalReportId" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"uploadedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"storageKey" text,
	"redacted" boolean DEFAULT false NOT NULL,
	"redactedAt" timestamp with time zone,
	"redactedSha256" text,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "submission_evidence_sha256_hex" CHECK ("submission_evidence"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submission_evidence_redacted_sha256_hex" CHECK ("submission_evidence"."redactedSha256" is null or "submission_evidence"."redactedSha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submission_evidence_bytes_range" CHECK ("submission_evidence"."bytes" between 1 and 20971520)
);
--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD COLUMN "userId" text;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD COLUMN "status" "submission_status" DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD COLUMN "decidedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD COLUMN "decidedBy" text;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD COLUMN "rejectReason" text;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD COLUMN "outcomeAmendedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "status" "review_status" DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "bindingId" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "decidedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "decidedBy" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "rejectReason" text;--> statement-breakpoint
ALTER TABLE "submission_evidence" ADD CONSTRAINT "submission_evidence_withdrawalReportId_withdrawal_report_id_fk" FOREIGN KEY ("withdrawalReportId") REFERENCES "public"."withdrawal_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submission_evidence_report_idx" ON "submission_evidence" USING btree ("withdrawalReportId");--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD CONSTRAINT "withdrawal_report_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_bindingId_user_brand_binding_id_fk" FOREIGN KEY ("bindingId") REFERENCES "public"."user_brand_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawal_report_binding_idx" ON "withdrawal_report" USING btree ("bindingId","requestedAt");--> statement-breakpoint
CREATE INDEX "withdrawal_report_status_idx" ON "withdrawal_report" USING btree ("status","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "review_user_brand_active_uq" ON "review" USING btree ("userId","brandId") WHERE "review"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "review_status_idx" ON "review" USING btree ("status","createdAt");--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD CONSTRAINT "withdrawal_report_received_after_requested" CHECK ("withdrawal_report"."receivedAt" is null or "withdrawal_report"."receivedAt" >= "withdrawal_report"."requestedAt");--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD CONSTRAINT "withdrawal_report_amount_positive" CHECK ("withdrawal_report"."amountUsdt" > 0);--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_text_len" CHECK ("review"."text" is null or char_length("review"."text") <= 500);--> statement-breakpoint
-- ===================== 手写部分 =====================
-- 依据：D-024 方案（to-audit「[D-024 方案]」）· W3#073 裁定 ①–④ 与补充 1–2 · architecture v1.18 §5 S4
-- 口径：存量行与 owner 回填（bydp.allow_backfill，seed / demo）保持 accepted / published；应用角色的新提交一律由触发器强制 pending；
--       审核状态单向；判定后核心列锁死；trustWeight 由数据库按绑定等级写入（应用不能自定）。

-- 0) 回填判定（与 bydp_server_ts 同口径：owner 身份 + bydp.allow_backfill = on；自定义参数任何会话都能 SET，故以 owner 为闸门）
CREATE OR REPLACE FUNCTION bydp_is_backfill(p_table text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('bydp.allow_backfill', true), 'off') = 'on'
     AND current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = p_table)
$$;--> statement-breakpoint

-- 1) 出款凭证提交（INSERT）：应用角色的新行一律强制 pending（含 official），申报时间不得在未来（F8）；kind = user 另须本人、同品牌、未失效的绑定且绑定早于申请提款（纠纷前绑定）；
--    写入端 A-005 限额：同一绑定在该凭证 requestedAt 前后 30 天内已有 3 条未驳回凭证即拒绝（比计分端滑动窗口更严）。
--    并发（补充 1）：先 FOR UPDATE 锁绑定行再计数——同一绑定的并发提交在此串行，不会超额。
CREATE OR REPLACE FUNCTION bydp_withdrawal_submit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; n integer;
BEGIN
  IF bydp_is_backfill('withdrawal_report') THEN
    RETURN NEW;
  END IF;
  -- 应用角色的任何新行（含 kind = official）都先待审，不能直接以 accepted 计分
  NEW."status" := 'pending';
  NEW."decidedAt" := NULL; NEW."decidedBy" := NULL; NEW."rejectReason" := NULL; NEW."outcomeAmendedAt" := NULL;
  -- F8（W2#002）：申报时间不得晚于当前时间（容忍 10 分钟时钟偏差）——否则可往未来分散日期绕过 ±30 天限额，未来的 pending 也永远不触发 72h 计拒付
  IF NEW."requestedAt" > now() + interval '10 minutes' OR NEW."receivedAt" > now() + interval '10 minutes' THEN
    RAISE EXCEPTION 'withdrawal_report: requestedAt / receivedAt must not be in the future'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_time_in_future';
  END IF;
  IF NEW."kind" <> 'user' THEN
    RETURN NEW;
  END IF;
  IF NEW."userId" IS NULL OR NEW."bindingId" IS NULL THEN
    RAISE EXCEPTION 'withdrawal_report: user submission requires userId and bindingId'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_binding_required';
  END IF;
  SELECT "userId", "brandId", "boundAt", "revokedAt" INTO b FROM "user_brand_binding" WHERE "id" = NEW."bindingId" FOR UPDATE;
  IF NOT FOUND OR b."userId" IS DISTINCT FROM NEW."userId" OR b."brandId" IS DISTINCT FROM NEW."brandId" OR b."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'withdrawal_report: binding must belong to the submitter and the same brand'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_binding_required';
  END IF;
  IF b."boundAt" > NEW."requestedAt" THEN
    RAISE EXCEPTION 'withdrawal_report: binding must predate the withdrawal request'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_binding_after_request';
  END IF;
  SELECT count(*) INTO n FROM "withdrawal_report" w
  WHERE w."bindingId" = NEW."bindingId" AND w."status" <> 'rejected'
    AND w."requestedAt" > NEW."requestedAt" - interval '30 days' AND w."requestedAt" < NEW."requestedAt" + interval '30 days';
  IF n >= 3 THEN
    RAISE EXCEPTION 'withdrawal_report: at most 3 reports per binding within 30 days'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_binding_limit';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS withdrawal_report_submit_guard ON "withdrawal_report";--> statement-breakpoint
CREATE TRIGGER withdrawal_report_submit_guard BEFORE INSERT ON "withdrawal_report"
  FOR EACH ROW EXECUTE FUNCTION bydp_withdrawal_submit_guard();--> statement-breakpoint

-- 2) 出款凭证更新（UPDATE，owner 回填除外，注销上下文只许驳回本人待审）：
--    核心列不可改；status 只能 pending → accepted | rejected（单向，同时写 decidedAt = now()）；判定列只随这次流转写入；
--    outcome 只能由 pending 补为 paid | refused 一次（写 outcomeAmendedAt = now()；paid 须 receivedAt，且不得晚于 now() + 10 分钟，F8）。
CREATE OR REPLACE FUNCTION bydp_withdrawal_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF bydp_is_backfill('withdrawal_report') THEN
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."brandId" IS DISTINCT FROM OLD."brandId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."amountUsdt" IS DISTINCT FROM OLD."amountUsdt" OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" OR NEW."bindingId" IS DISTINCT FROM OLD."bindingId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."complaintId" IS DISTINCT FROM OLD."complaintId" THEN
    RAISE EXCEPTION 'withdrawal_report: core fields are immutable'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'withdrawal_report_immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'pending' THEN
      RAISE EXCEPTION 'withdrawal_report: decision is final'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'withdrawal_report_decision_final';
    END IF;
    NEW."decidedAt" := now();
    IF NEW."decidedBy" IS NULL OR (NEW."status" = 'rejected' AND coalesce(btrim(NEW."rejectReason"), '') = '') THEN
      RAISE EXCEPTION 'withdrawal_report: decision requires decidedBy (and rejectReason when rejected)'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_decision_fields';
    END IF;
  ELSIF NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."decidedBy" IS DISTINCT FROM OLD."decidedBy"
        OR NEW."rejectReason" IS DISTINCT FROM OLD."rejectReason" THEN
    RAISE EXCEPTION 'withdrawal_report: decision fields change only with the decision'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'withdrawal_report_decision_final';
  END IF;
  IF NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."outcomeAmendedAt" IS DISTINCT FROM OLD."outcomeAmendedAt" THEN
    IF OLD."outcome" <> 'pending' OR OLD."outcomeAmendedAt" IS NOT NULL OR NEW."outcome" = 'pending'
       OR (NEW."outcome" = 'paid' AND NEW."receivedAt" IS NULL) OR (NEW."outcome" = 'refused' AND NEW."receivedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'withdrawal_report: outcome may be amended once, from pending to paid (with receivedAt) or refused'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_outcome_amend';
    END IF;
    IF NEW."receivedAt" > now() + interval '10 minutes' THEN
      RAISE EXCEPTION 'withdrawal_report: receivedAt must not be in the future'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_report_time_in_future';
    END IF;
    NEW."outcomeAmendedAt" := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS withdrawal_report_update_guard ON "withdrawal_report";--> statement-breakpoint
CREATE TRIGGER withdrawal_report_update_guard BEFORE UPDATE ON "withdrawal_report"
  FOR EACH ROW EXECUTE FUNCTION bydp_withdrawal_update_guard();--> statement-breakpoint

-- 3) 评价提交（INSERT）：新行强制 pending；须本人、同品牌、未失效的绑定（无绑定不可提交）；先 FOR UPDATE 锁绑定行（与同品牌并发提交串行）；
--    trustWeight（architecture §5 S4 v1.18 · 裁定 ①）：运营商确认 / 回传确认 = 1.0；自报级且绑定满 30 天 = 0.5；自报级不满 30 天 = 0.2。
--    verifiedBinding = 非自报级；helpful 从 0 起。每人每品牌一条有效评价由部分唯一索引 review_user_brand_active_uq 保证。
CREATE OR REPLACE FUNCTION bydp_review_submit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  IF bydp_is_backfill('review') THEN
    RETURN NEW;
  END IF;
  NEW."status" := 'pending';
  NEW."decidedAt" := NULL; NEW."decidedBy" := NULL; NEW."rejectReason" := NULL; NEW."helpful" := 0;
  IF NEW."bindingId" IS NULL THEN
    RAISE EXCEPTION 'review: submission requires a binding'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'review_binding_required';
  END IF;
  SELECT "userId", "brandId", "boundAt", "revokedAt", "verificationLevel" INTO b FROM "user_brand_binding" WHERE "id" = NEW."bindingId" FOR UPDATE;
  IF NOT FOUND OR b."userId" IS DISTINCT FROM NEW."userId" OR b."brandId" IS DISTINCT FROM NEW."brandId" OR b."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'review: binding must belong to the reviewer and the same brand'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'review_binding_required';
  END IF;
  NEW."verifiedBinding" := b."verificationLevel" <> 'self_reported';
  NEW."trustWeight" := CASE
    WHEN b."verificationLevel" IN ('postback_confirmed', 'operator_confirmed') THEN 1.0
    WHEN b."boundAt" <= now() - interval '30 days' THEN 0.5
    ELSE 0.2 END;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS review_submit_guard ON "review";--> statement-breakpoint
CREATE TRIGGER review_submit_guard BEFORE INSERT ON "review"
  FOR EACH ROW EXECUTE FUNCTION bydp_review_submit_guard();--> statement-breakpoint

-- 4) 评价更新（UPDATE，owner 回填除外）：rating / trustWeight / 身份列不可改；status 只能 pending → published | rejected（单向）；
--    text 只在注销上下文（bydp_in_anonymize）内可改为「（已注销）」；helpful 可变（计数）。
CREATE OR REPLACE FUNCTION bydp_review_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF bydp_is_backfill('review') THEN
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."brandId" IS DISTINCT FROM OLD."brandId" OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."rating" IS DISTINCT FROM OLD."rating" OR NEW."trustWeight" IS DISTINCT FROM OLD."trustWeight"
     OR NEW."verifiedBinding" IS DISTINCT FROM OLD."verifiedBinding" OR NEW."bindingId" IS DISTINCT FROM OLD."bindingId" THEN
    RAISE EXCEPTION 'review: rating, weight and identity fields are immutable'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'review_immutable';
  END IF;
  IF NEW."text" IS DISTINCT FROM OLD."text" AND NOT (bydp_in_anonymize() AND NEW."text" = '（已注销）') THEN
    RAISE EXCEPTION 'review: text is immutable (anonymize only)'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'review_immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'pending' THEN
      RAISE EXCEPTION 'review: decision is final'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'review_decision_final';
    END IF;
    NEW."decidedAt" := now();
    IF NEW."decidedBy" IS NULL OR (NEW."status" = 'rejected' AND coalesce(btrim(NEW."rejectReason"), '') = '') THEN
      RAISE EXCEPTION 'review: decision requires decidedBy (and rejectReason when rejected)'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'review_decision_fields';
    END IF;
  ELSIF NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."decidedBy" IS DISTINCT FROM OLD."decidedBy"
        OR NEW."rejectReason" IS DISTINCT FROM OLD."rejectReason" THEN
    RAISE EXCEPTION 'review: decision fields change only with the decision'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'review_decision_final';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS review_update_guard ON "review";--> statement-breakpoint
CREATE TRIGGER review_update_guard BEFORE UPDATE ON "review"
  FOR EACH ROW EXECUTE FUNCTION bydp_review_update_guard();--> statement-breakpoint

-- 5) 凭证截图（submission_evidence）：与 evidence 同口径——哈希行只追加；原文对象可脱敏 / 删除且不可逆；不可删行；uploadedAt 服务端时间。
--    另：只能挂在 kind = user 且仍 pending 的凭证上（判定后不再补证据）。
CREATE OR REPLACE FUNCTION bydp_submission_evidence_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF bydp_is_backfill('submission_evidence') THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "withdrawal_report" WHERE "id" = NEW."withdrawalReportId" AND "kind" = 'user' AND "status" = 'pending' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission_evidence: only attachable to a pending user withdrawal report'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'submission_evidence_report_pending';
  END IF;
  NEW."redacted" := false; NEW."redactedAt" := NULL; NEW."redactedSha256" := NULL; NEW."deletedAt" := NULL;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS submission_evidence_insert_guard ON "submission_evidence";--> statement-breakpoint
CREATE TRIGGER submission_evidence_insert_guard BEFORE INSERT ON "submission_evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_submission_evidence_insert_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS submission_evidence_server_ts ON "submission_evidence";--> statement-breakpoint
CREATE TRIGGER submission_evidence_server_ts BEFORE INSERT ON "submission_evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('uploadedAt');--> statement-breakpoint
CREATE OR REPLACE FUNCTION bydp_submission_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."withdrawalReportId" IS DISTINCT FROM OLD."withdrawalReportId"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."mime" IS DISTINCT FROM OLD."mime"
     OR NEW."bytes" IS DISTINCT FROM OLD."bytes" OR NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt" THEN
    RAISE EXCEPTION 'submission_evidence: hash record is append-only (only storageKey/redacted/redactedAt/redactedSha256/deletedAt may change)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."redacted" AND NOT NEW."redacted" THEN
    RAISE EXCEPTION 'submission_evidence: redaction is irreversible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."redactedSha256" IS NOT NULL AND NEW."redactedSha256" IS DISTINCT FROM OLD."redactedSha256" THEN
    RAISE EXCEPTION 'submission_evidence: redactedSha256 is write-once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."deletedAt" IS NOT NULL AND (NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" OR NEW."storageKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'submission_evidence: deletion is irreversible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."deletedAt" IS NOT NULL AND NEW."storageKey" IS NOT NULL THEN
    RAISE EXCEPTION 'submission_evidence: deleted evidence must not reference an object' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."redacted" AND NEW."storageKey" IS NOT NULL AND NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
    RAISE EXCEPTION 'submission_evidence: redacted evidence object cannot be re-pointed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS submission_evidence_guard_update ON "submission_evidence";--> statement-breakpoint
CREATE TRIGGER submission_evidence_guard_update BEFORE UPDATE ON "submission_evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_submission_evidence_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS submission_evidence_no_delete ON "submission_evidence";--> statement-breakpoint
CREATE TRIGGER submission_evidence_no_delete BEFORE DELETE ON "submission_evidence"
  FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS submission_evidence_no_truncate ON "submission_evidence";--> statement-breakpoint
CREATE TRIGGER submission_evidence_no_truncate BEFORE TRUNCATE ON "submission_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- 6) 授权（rules/db-migration.md：新表逐表授权；只追加表收回 UPDATE / DELETE / TRUNCATE，只开放原文侧列）
REVOKE ALL ON "submission_evidence" FROM bydp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "submission_evidence" TO bydp_app;--> statement-breakpoint
GRANT UPDATE ("storageKey", "redacted", "redactedAt", "redactedSha256", "deletedAt") ON "submission_evidence" TO bydp_app;--> statement-breakpoint
-- 评价：信任域记录不可删（与 withdrawal_report 同口径，0002 R2）
REVOKE DELETE, TRUNCATE ON "review" FROM bydp_app;--> statement-breakpoint
-- scoring_ro（ADR-0006 第 ③ 层白名单）：只加两表的 status 列；不授予 userId / text / 证据 / 判定人
GRANT SELECT ("status") ON "withdrawal_report", "review" TO bydp_scoring_ro;--> statement-breakpoint
-- bydp_agent：不授予新表与新列（Agent 不读用户提交）

-- 7) 注销（补充 2）：bydp_anonymize_user 覆盖新表——凭证截图原文删除（哈希保留，返回对象键供应用层删 R2 对象）、
--    评价文字置「（已注销）」、本人待审提交一律驳回。其余与 0013 原文一致。
CREATE OR REPLACE FUNCTION bydp_anonymize_user(p_user_id text, p_request_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  req record;
  bal integer;
  v_perm boolean;
  v_until timestamptz;
  v_keys jsonb;
  n_bind integer; n_ident integer; n_pref integer; n_sub integer; n_notif integer; n_role integer;
  n_block integer := 0; n_desc integer; n_ev integer;
  v_skeys jsonb; n_sev integer; n_rv integer; n_pend integer;
BEGIN
  SELECT u."points" INTO bal FROM "app_user" u WHERE u."id" = p_user_id AND u."anonymizedAt" IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anonymize: user missing or already anonymized' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."userId", r."kind", r."status", r."contactChannel" INTO req FROM "data_request" r WHERE r."id" = p_request_id FOR UPDATE;
  IF NOT FOUND OR req."userId" IS DISTINCT FROM p_user_id OR req."kind" <> 'anonymize' OR req."status" <> 'pending' THEN
    RAISE EXCEPTION 'anonymize: no pending anonymize request % for user', p_request_id USING ERRCODE = 'check_violation';
  END IF;
  IF req."contactChannel" IS NULL THEN
    RAISE EXCEPTION 'anonymize: contact confirmation required' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "complaint" c WHERE c."userId" = p_user_id AND c."status"::text NOT IN ('resolved', 'rejected', 'exposed')) THEN
    RAISE EXCEPTION 'anonymize: open complaints must be closed first' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('bydp.anonymize', p_request_id, true);

  IF bal > 0 THEN
    INSERT INTO "points_event" ("id", "userId", "event", "points", "refType", "refId", "dedupeKey")
    VALUES ('pe_' || replace(gen_random_uuid()::text, '-', ''), p_user_id, 'anonymize_reversal', -bal, 'data_request', p_request_id, 'anonymize:' || p_request_id);
  END IF;

  UPDATE "user_brand_binding" SET "revokedAt" = now(), "compensationEligible" = false, "updatedAt" = now()
  WHERE "userId" = p_user_id AND "revokedAt" IS NULL;
  GET DIAGNOSTICS n_bind = ROW_COUNT;

  -- 身份封禁：须在删除 identity 之前取哈希
  SELECT EXISTS (SELECT 1 FROM "self_exclusion" s WHERE s."userId" = p_user_id AND s."period" = 'permanent') INTO v_perm;
  SELECT max(s."endsAt") INTO v_until FROM "self_exclusion" s WHERE s."userId" = p_user_id AND s."period" <> 'permanent' AND s."endsAt" > now();
  IF v_perm OR v_until IS NOT NULL THEN
    INSERT INTO "identity_block" ("id", "identityHash", "blockedUntil", "requestId")
    SELECT 'ib_' || replace(gen_random_uuid()::text, '-', ''), i."providerAccountId", CASE WHEN v_perm THEN NULL ELSE v_until END, p_request_id
    FROM "identity" i WHERE i."userId" = p_user_id AND i."providerAccountId" IS NOT NULL;
    GET DIAGNOSTICS n_block = ROW_COUNT;
  END IF;

  -- 已结案案件：证据原文删除（哈希保留）、原文用公开陈述覆盖
  SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId', e."id", 'storageKey', e."storageKey") ORDER BY e."id"), '[]'::jsonb) INTO v_keys
  FROM "evidence" e JOIN "complaint" c ON c."id" = e."complaintId"
  WHERE c."userId" = p_user_id AND e."deletedAt" IS NULL AND e."storageKey" IS NOT NULL;
  UPDATE "evidence" e SET "deletedAt" = now(), "storageKey" = NULL
  FROM "complaint" c WHERE c."id" = e."complaintId" AND c."userId" = p_user_id AND e."deletedAt" IS NULL AND e."storageKey" IS NOT NULL;
  GET DIAGNOSTICS n_ev = ROW_COUNT;
  UPDATE "complaint" SET "description" = coalesce("publicDescription", '（已注销）'),
                         "title" = CASE WHEN "publicSummary" THEN "title" ELSE '（已注销）' END
  WHERE "userId" = p_user_id
    AND ("description" IS DISTINCT FROM coalesce("publicDescription", '（已注销）')
         OR "title" IS DISTINCT FROM CASE WHEN "publicSummary" THEN "title" ELSE '（已注销）' END);
  GET DIAGNOSTICS n_desc = ROW_COUNT;

  -- A-019：出款凭证截图原文删除（哈希保留）；评价文字清空为「（已注销）」；未审核的提交一律驳回（原因「（已注销）」）
  SELECT coalesce(jsonb_agg(jsonb_build_object('submissionEvidenceId', se."id", 'storageKey', se."storageKey") ORDER BY se."id"), '[]'::jsonb) INTO v_skeys
  FROM "submission_evidence" se JOIN "withdrawal_report" w ON w."id" = se."withdrawalReportId"
  WHERE w."userId" = p_user_id AND se."deletedAt" IS NULL AND se."storageKey" IS NOT NULL;
  UPDATE "submission_evidence" se SET "deletedAt" = now(), "storageKey" = NULL
  FROM "withdrawal_report" w WHERE w."id" = se."withdrawalReportId" AND w."userId" = p_user_id AND se."deletedAt" IS NULL AND se."storageKey" IS NOT NULL;
  GET DIAGNOSTICS n_sev = ROW_COUNT;
  UPDATE "withdrawal_report" SET "status" = 'rejected', "decidedAt" = now(), "decidedBy" = 'system:anonymize', "rejectReason" = '（已注销）'
  WHERE "userId" = p_user_id AND "status" = 'pending';
  GET DIAGNOSTICS n_pend = ROW_COUNT;
  UPDATE "review" SET "status" = 'rejected', "decidedAt" = now(), "decidedBy" = 'system:anonymize', "rejectReason" = '（已注销）'
  WHERE "userId" = p_user_id AND "status" = 'pending';
  UPDATE "review" SET "text" = '（已注销）' WHERE "userId" = p_user_id AND "text" IS DISTINCT FROM '（已注销）';
  GET DIAGNOSTICS n_rv = ROW_COUNT;

  DELETE FROM "identity" WHERE "userId" = p_user_id;          GET DIAGNOSTICS n_ident = ROW_COUNT;
  DELETE FROM "user_preference" WHERE "userId" = p_user_id;   GET DIAGNOSTICS n_pref = ROW_COUNT;
  DELETE FROM "subscription" WHERE "userId" = p_user_id;      GET DIAGNOSTICS n_sub = ROW_COUNT;
  DELETE FROM "notification" WHERE "userId" = p_user_id;      GET DIAGNOSTICS n_notif = ROW_COUNT;
  DELETE FROM "user_role" WHERE "userId" = p_user_id;         GET DIAGNOSTICS n_role = ROW_COUNT;

  UPDATE "app_user" SET "displayName" = '已注销用户', "region" = NULL, "sessionEpoch" = "sessionEpoch" + 1,
                        "anonymizedAt" = now(), "updatedAt" = now()
  WHERE "id" = p_user_id;

  PERFORM set_config('bydp.anonymize', '', true);
  RETURN jsonb_build_object('pointsReversed', greatest(bal, 0), 'bindingsRevoked', n_bind, 'identities', n_ident,
                            'preferences', n_pref, 'subscriptions', n_sub, 'notifications', n_notif, 'roles', n_role,
                            'identityBlocks', n_block, 'descriptionsOverwritten', n_desc, 'evidenceDeleted', n_ev, 'evidenceKeys', v_keys,
                            'submissionEvidenceDeleted', n_sev, 'submissionEvidenceKeys', v_skeys,
                            'reviewsCleared', n_rv, 'pendingSubmissionsRejected', n_pend);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION bydp_anonymize_user(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION bydp_anonymize_user(text, text) TO bydp_app;--> statement-breakpoint

-- 8) 规则（rules/db-migration.md）：重跑 createdAt 触发器循环（新表 submission_evidence 无 createdAt，以 uploadedAt 服务端时间代替；循环照跑以覆盖全部表）
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'createdAt' ORDER BY table_name LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.table_name || '_created_at_server_ts', r.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION bydp_server_ts(%L)',
                   r.table_name || '_created_at_server_ts', r.table_name, 'createdAt');
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.table_name || '_created_at_immutable', r.table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bydp_immutable_col(%L)',
                   r.table_name || '_created_at_immutable', r.table_name, 'createdAt');
  END LOOP;
END $$;
