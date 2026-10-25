CREATE TABLE "verification_token" (
	"identifierHash" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_token_identifierHash_tokenHash_pk" PRIMARY KEY("identifierHash","tokenHash"),
	CONSTRAINT "verification_token_identifier_hex" CHECK ("verification_token"."identifierHash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "verification_token_token_hex" CHECK ("verification_token"."tokenHash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "identity" ADD COLUMN "contactEnc" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "sessionEpoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "verification_token_expires_idx" ON "verification_token" USING btree ("expires");--> statement-breakpoint
ALTER TABLE "identity" ADD CONSTRAINT "identity_account_hash_hex" CHECK ("identity"."providerAccountId" is null or "identity"."providerAccountId" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "identity" ADD CONSTRAINT "identity_contact_enc_shape" CHECK ("identity"."contactEnc" is null or "identity"."contactEnc" ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');--> statement-breakpoint

-- A-009：identity 的 provider / providerAccountId 写入后不可改（NULL → 值允许一次，兼容 seed 空行回填；表 owner 同样受约束）
CREATE OR REPLACE FUNCTION bydp_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR (OLD."providerAccountId" IS NOT NULL AND NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId") THEN
    RAISE EXCEPTION 'identity: provider / providerAccountId are immutable once set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS identity_guard ON "identity";--> statement-breakpoint
CREATE TRIGGER identity_guard BEFORE UPDATE ON "identity" FOR EACH ROW EXECUTE FUNCTION bydp_identity_guard();--> statement-breakpoint

-- 审核建议 4（D-007：validTo 走 0006 双签）：commission_term.validTo 改动后不得早于当天，禁止回溯截断已生效区间（表 owner 同样受约束）
CREATE OR REPLACE FUNCTION bydp_commission_term_validto_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."validTo" IS DISTINCT FROM OLD."validTo" AND NEW."validTo" IS NOT NULL AND NEW."validTo" < current_date THEN
    RAISE EXCEPTION 'commission_term.validTo may not be set earlier than today' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS commission_term_validto_guard ON "commission_term";--> statement-breakpoint
CREATE TRIGGER commission_term_validto_guard BEFORE UPDATE OF "validTo" ON "commission_term" FOR EACH ROW EXECUTE FUNCTION bydp_commission_term_validto_guard();--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖新表 verification_token
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

-- 授权：verification_token 只给 bydp_app SELECT / INSERT / DELETE（取出即删，无 UPDATE）；scoring_ro 不授权（白名单 15 张不变）
GRANT SELECT, INSERT, DELETE ON "verification_token" TO bydp_app;
