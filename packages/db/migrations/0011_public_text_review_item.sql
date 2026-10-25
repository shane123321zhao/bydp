CREATE TYPE "public"."review_item_kind" AS ENUM('brand_attribute', 'site_monitor', 'complaint_screening', 'localization');--> statement-breakpoint
CREATE TYPE "public"."review_item_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "review_item" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "review_item_kind" NOT NULL,
	"subject" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"source" text NOT NULL,
	"status" "review_item_status" DEFAULT 'pending' NOT NULL,
	"decidedBy" text,
	"decidedAt" timestamp with time zone,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_item_proposal_object" CHECK (jsonb_typeof("review_item"."proposal") = 'object'),
	CONSTRAINT "review_item_subject_len" CHECK (char_length("review_item"."subject") between 1 and 128),
	CONSTRAINT "review_item_source_len" CHECK (char_length("review_item"."source") between 1 and 64),
	CONSTRAINT "review_item_note_len" CHECK ("review_item"."note" is null or char_length("review_item"."note") <= 500),
	CONSTRAINT "review_item_decided_pair" CHECK (("review_item"."status" = 'pending') = ("review_item"."decidedAt" is null) and ("review_item"."decidedAt" is null) = ("review_item"."decidedBy" is null))
);
--> statement-breakpoint
ALTER TABLE "complaint" ADD COLUMN "publicDescription" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "redactedSha256" text;--> statement-breakpoint
ALTER TABLE "data_request" ADD COLUMN "contactConfirmedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_request" ADD COLUMN "contactChannel" "notify_channel";--> statement-breakpoint
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_decidedBy_app_user_id_fk" FOREIGN KEY ("decidedBy") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_item_queue_idx" ON "review_item" USING btree ("status","kind","createdAt");--> statement-breakpoint
CREATE INDEX "review_item_subject_idx" ON "review_item" USING btree ("kind","subject");--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_public_description_len" CHECK ("complaint"."publicDescription" is null or char_length("complaint"."publicDescription") between 1 and 500);--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_redacted_sha256_hex" CHECK ("evidence"."redactedSha256" is null or "evidence"."redactedSha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "data_request" ADD CONSTRAINT "data_request_contact_pair" CHECK (("data_request"."contactConfirmedAt" is null) = ("data_request"."contactChannel" is null));--> statement-breakpoint
ALTER TABLE "data_request" ADD CONSTRAINT "data_request_contact_only_anonymize" CHECK ("data_request"."contactConfirmedAt" is null or "data_request"."kind" = 'anonymize');--> statement-breakpoint
ALTER TABLE "data_request" ADD CONSTRAINT "data_request_anonymize_needs_contact" CHECK ("data_request"."kind" <> 'anonymize' or "data_request"."status" <> 'done' or "data_request"."contactConfirmedAt" is not null);--> statement-breakpoint

-- A-014 Q1：已公开的存量案件，其投诉原文此前即由公开案件页展示（P1 / M2 口径），回填为公开陈述，不产生新的公开范围；
-- 之后公开一律经仲裁台人工脱敏写入本列（生产库全新初始化，存量仅 seed / 测试站）。complaint 非只追加表。
UPDATE "complaint" SET "publicDescription" = "description" WHERE "publicSummary" AND "publicDescription" IS NULL;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_public_needs_text" CHECK (not "complaint"."publicSummary" or "complaint"."publicDescription" is not null);--> statement-breakpoint

-- 证据守卫扩展：redactedSha256 只能随「标记脱敏」一次写入（NULL → 值，且 NEW.redacted），之后不可改
CREATE OR REPLACE FUNCTION bydp_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."complaintId" IS DISTINCT FROM OLD."complaintId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."label" IS DISTINCT FROM OLD."label"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."txHash" IS DISTINCT FROM OLD."txHash"
     OR NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt" THEN
    RAISE EXCEPTION 'evidence: hash record is append-only (only storageKey/redacted/redactedAt/redactedSha256/deletedAt may change)'
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
  -- A-014：脱敏件哈希只随标记脱敏一次写入
  IF NEW."redactedSha256" IS DISTINCT FROM OLD."redactedSha256" AND (OLD."redactedSha256" IS NOT NULL OR NOT NEW."redacted") THEN
    RAISE EXCEPTION 'evidence: redactedSha256 is set once together with redaction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
GRANT UPDATE ("redactedSha256") ON "evidence" TO bydp_app;--> statement-breakpoint

-- 数据请求守卫扩展（§9.2 v1.9）：contactChannel 只能在待处理时 NULL → 值一次，确认时刻由服务端置 now()；之后不可改
CREATE OR REPLACE FUNCTION bydp_data_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."targetIds" IS DISTINCT FROM OLD."targetIds" OR NEW."note" IS DISTINCT FROM OLD."note" THEN
    RAISE EXCEPTION 'data_request: only status / contact confirmation can change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."contactChannel" IS DISTINCT FROM OLD."contactChannel" THEN
    IF OLD."contactChannel" IS NOT NULL OR OLD."status" <> 'pending' THEN
      RAISE EXCEPTION 'data_request: contact confirmation is set once while pending' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."contactConfirmedAt" := now();
  ELSIF NEW."contactConfirmedAt" IS DISTINCT FROM OLD."contactConfirmedAt" THEN
    RAISE EXCEPTION 'data_request.contactConfirmedAt is server-set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'pending' THEN
      RAISE EXCEPTION 'data_request: status % is final', OLD."status" USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."resolvedAt" := now();
  ELSIF NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" THEN
    RAISE EXCEPTION 'data_request.resolvedAt is server-set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
GRANT UPDATE ("contactConfirmedAt", "contactChannel") ON "data_request" TO bydp_app;--> statement-breakpoint

-- review_item：proposal / kind / subject / source 写入后不可改；status 只能 pending → approved | rejected 一次，decidedAt 服务端置 now()；
-- note 只能随决定一并写入；不可删（owner 同拦）
CREATE OR REPLACE FUNCTION bydp_review_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."subject" IS DISTINCT FROM OLD."subject"
     OR NEW."proposal" IS DISTINCT FROM OLD."proposal" OR NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'review_item: proposal is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'review_item: decision % is final', OLD."status" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" = 'pending' THEN
    RAISE EXCEPTION 'review_item: only a decision (approved / rejected) may update a pending item' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."decidedAt" := now();
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS review_item_guard ON "review_item";--> statement-breakpoint
CREATE TRIGGER review_item_guard BEFORE UPDATE ON "review_item" FOR EACH ROW EXECUTE FUNCTION bydp_review_item_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS review_item_no_delete ON "review_item";--> statement-breakpoint
CREATE TRIGGER review_item_no_delete BEFORE DELETE ON "review_item" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS review_item_no_truncate ON "review_item";--> statement-breakpoint
CREATE TRIGGER review_item_no_truncate BEFORE TRUNCATE ON "review_item" FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖新表 review_item
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
END $$;--> statement-breakpoint

-- 授权：review_item 新建只能是待处理（status / decidedAt / decidedBy / note 不在 INSERT 列内）；scoring_ro 不授权（白名单不变）
REVOKE ALL ON "review_item" FROM bydp_app;--> statement-breakpoint
GRANT SELECT ON "review_item" TO bydp_app;--> statement-breakpoint
GRANT INSERT ("id", "kind", "subject", "proposal", "source", "createdAt") ON "review_item" TO bydp_app;--> statement-breakpoint
GRANT UPDATE ("status", "decidedBy", "decidedAt", "note") ON "review_item" TO bydp_app;
