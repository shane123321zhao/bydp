CREATE TYPE "public"."commission_term_mode" AS ENUM('cpa', 'revshare');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('active', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."conversion_event" ADD VALUE 'reversal';--> statement-breakpoint
CREATE TABLE "commission_event" (
	"id" text PRIMARY KEY NOT NULL,
	"commissionId" text NOT NULL,
	"status" "commission_status" NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_term" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"partnerId" text,
	"mode" "commission_term_mode" NOT NULL,
	"cpaUsdt" numeric(18, 2),
	"sharePct" numeric(5, 4),
	"validFrom" date NOT NULL,
	"validTo" date,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_term_mode_fields" CHECK (("commission_term"."mode" = 'cpa' and "commission_term"."cpaUsdt" is not null and "commission_term"."cpaUsdt" >= 0 and "commission_term"."sharePct" is null)
       or ("commission_term"."mode" = 'revshare' and "commission_term"."sharePct" is not null and "commission_term"."sharePct" > 0 and "commission_term"."sharePct" <= 1 and "commission_term"."cpaUsdt" is null)),
	CONSTRAINT "commission_term_range" CHECK ("commission_term"."validTo" is null or "commission_term"."validTo" > "commission_term"."validFrom")
);
--> statement-breakpoint
CREATE TABLE "operator_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"postbackSecretRef" text NOT NULL,
	"timeWindowSec" integer DEFAULT 300 NOT NULL,
	"status" "integration_status" DEFAULT 'active' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_integration_secret_ref" CHECK ("operator_integration"."postbackSecretRef" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
	CONSTRAINT "operator_integration_window" CHECK ("operator_integration"."timeWindowSec" between 30 and 300)
);
--> statement-breakpoint
DROP INDEX "conversion_brand_account_idx";--> statement-breakpoint
DROP INDEX "commission_brand_idx";--> statement-breakpoint
ALTER TABLE "brand" ADD COLUMN "redirectTemplate" text;--> statement-breakpoint
ALTER TABLE "commission" ADD COLUMN "termId" text;--> statement-breakpoint
ALTER TABLE "conversion" ADD COLUMN "externalEventId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion" ADD COLUMN "operatorAccountIdHash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion" ADD COLUMN "reversesId" text;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "redirectTemplate" text;--> statement-breakpoint
ALTER TABLE "commission_event" ADD CONSTRAINT "commission_event_commissionId_commission_id_fk" FOREIGN KEY ("commissionId") REFERENCES "public"."commission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_term" ADD CONSTRAINT "commission_term_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_term" ADD CONSTRAINT "commission_term_partnerId_partner_id_fk" FOREIGN KEY ("partnerId") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_integration" ADD CONSTRAINT "operator_integration_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_event_commission_idx" ON "commission_event" USING btree ("commissionId","createdAt");--> statement-breakpoint
CREATE INDEX "commission_term_brand_idx" ON "commission_term" USING btree ("brandId","validFrom");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_integration_brand_uq" ON "operator_integration" USING btree ("brandId");--> statement-breakpoint
ALTER TABLE "commission" ADD CONSTRAINT "commission_termId_commission_term_id_fk" FOREIGN KEY ("termId") REFERENCES "public"."commission_term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_reversesId_conversion_id_fk" FOREIGN KEY ("reversesId") REFERENCES "public"."conversion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversion_brand_hash_idx" ON "conversion" USING btree ("brandId","operatorAccountIdHash");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_brand_external_event_uq" ON "conversion" USING btree ("brandId","externalEventId");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_reverses_once_uq" ON "conversion" USING btree ("reversesId") WHERE "conversion"."reversesId" is not null;--> statement-breakpoint
CREATE INDEX "commission_brand_idx" ON "commission" USING btree ("brandId");--> statement-breakpoint
ALTER TABLE "commission" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "commission" DROP COLUMN "updatedAt";--> statement-breakpoint
ALTER TABLE "brand" ADD CONSTRAINT "brand_redirect_template_shape" CHECK ("brand"."redirectTemplate" is null or "brand"."redirectTemplate" ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/([^{}[:space:]@\\]|\{clickId\})*)?$');--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_reversal_shape" CHECK (("conversion"."event"::text = 'reversal') = ("conversion"."reversesId" is not null));--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_account_hash_hex" CHECK ("conversion"."operatorAccountIdHash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_redirect_template_shape" CHECK ("offer"."redirectTemplate" is null or "offer"."redirectTemplate" ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/([^{}[:space:]@\\]|\{clickId\})*)?$');--> statement-breakpoint
-- ===== 以下为手写部分（A-007）=====
-- 审核坑 1：partnerId 可空，排除约束用 coalesce 表达式；区间 [validFrom, validTo)，validTo 为空 = 无上界
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "commission_term" ADD CONSTRAINT "commission_term_no_overlap"
  EXCLUDE USING gist ("brandId" WITH =, (coalesce("partnerId", '')) WITH =, daterange("validFrom", "validTo", '[)') WITH &&);--> statement-breakpoint

-- G1：跳转模板目标主机必须属于该品牌 ownership=official 的域名 / 镜像标识（owner 同拦；www. 前缀忽略）
CREATE OR REPLACE FUNCTION bydp_redirect_host_ok(brand_id text, tpl text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT tpl IS NULL OR EXISTS (
    SELECT 1 FROM "identifier" i
    WHERE i."brandId" = brand_id AND i."ownership" = 'official' AND i."type" IN ('domain', 'mirror')
      -- 与形状 CHECK 同一字符集截取主机（A-007 F1：禁止 userinfo，主机只含 [A-Za-z0-9.-]）
      AND lower(i."value") = regexp_replace(lower(substring(tpl FROM '^https://([A-Za-z0-9.-]+)')), '^www\.', ''))
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bydp_offer_redirect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT bydp_redirect_host_ok(NEW."brandId", NEW."redirectTemplate") THEN
    RAISE EXCEPTION 'offer.redirectTemplate host must be an official domain of brand %', NEW."brandId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bydp_brand_redirect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT bydp_redirect_host_ok(NEW."id", NEW."redirectTemplate") THEN
    RAISE EXCEPTION 'brand.redirectTemplate host must be an official domain of brand %', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS offer_redirect_guard ON "offer";--> statement-breakpoint
CREATE TRIGGER offer_redirect_guard BEFORE INSERT OR UPDATE OF "redirectTemplate", "brandId" ON "offer"
  FOR EACH ROW EXECUTE FUNCTION bydp_offer_redirect_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS brand_redirect_guard ON "brand";--> statement-breakpoint
CREATE TRIGGER brand_redirect_guard BEFORE INSERT OR UPDATE OF "redirectTemplate" ON "brand"
  FOR EACH ROW EXECUTE FUNCTION bydp_brand_redirect_guard();--> statement-breakpoint

-- G2 / G3 / A-007 F2：click、conversion、commission、commission_event 只追加（owner 同拦；click 是归因证据）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['click', 'conversion', 'commission', 'commission_event'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;--> statement-breakpoint

-- A-007 F3：佣金条款写入后金额 / 模式 / 区间起点 / 归属不可改（owner 同拦）；只允许设置 validTo 截止——条款变更 = 截止旧条款 + 新建
CREATE OR REPLACE FUNCTION bydp_commission_term_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."brandId" IS DISTINCT FROM OLD."brandId" OR NEW."partnerId" IS DISTINCT FROM OLD."partnerId"
     OR NEW."mode" IS DISTINCT FROM OLD."mode" OR NEW."cpaUsdt" IS DISTINCT FROM OLD."cpaUsdt"
     OR NEW."sharePct" IS DISTINCT FROM OLD."sharePct" OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom" THEN
    RAISE EXCEPTION 'commission_term: only validTo may change (end the term and create a new one)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_term_guard ON "commission_term";--> statement-breakpoint
CREATE TRIGGER commission_term_guard BEFORE UPDATE ON "commission_term" FOR EACH ROW EXECUTE FUNCTION bydp_commission_term_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_term_no_delete ON "commission_term";--> statement-breakpoint
CREATE TRIGGER commission_term_no_delete BEFORE DELETE ON "commission_term" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- A-007 R1：ADR-0003「黑名单 / 关联方永不结佣」在 DB 层兜底（tracking 层仍先拦截）
CREATE OR REPLACE FUNCTION bydp_commission_eligibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "brand" b JOIN "operator" o ON o."id" = b."operatorId"
    WHERE b."id" = NEW."brandId" AND (b."status" = 'blacklist' OR o."relatedParty")
  ) THEN
    RAISE EXCEPTION 'commission forbidden: brand % is blacklisted or a related party (ADR-0003)', NEW."brandId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_eligibility_guard ON "commission";--> statement-breakpoint
CREATE TRIGGER commission_eligibility_guard BEFORE INSERT ON "commission" FOR EACH ROW EXECUTE FUNCTION bydp_commission_eligibility_guard();--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖新表 commission_term / commission_event / operator_integration
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

-- 授权：0002 的 ON ALL TABLES 不覆盖新表，逐表授予 bydp_app；scoring_ro 不授权任何新表（白名单 15 张不变）
GRANT SELECT, INSERT, UPDATE ON "operator_integration" TO bydp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commission_term", "commission_event" TO bydp_app;--> statement-breakpoint
-- A-007 F3：commission_term 只允许列级更新 validTo（与 updatedAt）
GRANT UPDATE ("validTo", "updatedAt") ON "commission_term" TO bydp_app;--> statement-breakpoint
-- A-007 F2：click 加入只追加
REVOKE UPDATE, DELETE, TRUNCATE ON "click", "conversion", "commission" FROM bydp_app;
