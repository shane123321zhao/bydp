CREATE TYPE "public"."data_request_kind" AS ENUM('redact_evidence', 'delete_evidence', 'export', 'anonymize');--> statement-breakpoint
CREATE TYPE "public"."data_request_status" AS ENUM('pending', 'done', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."self_exclusion_period" AS ENUM('30', '90', '180', '365', 'permanent');--> statement-breakpoint
CREATE TABLE "data_request" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"kind" "data_request_kind" NOT NULL,
	"targetIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "data_request_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvedAt" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_request_target_ids_array" CHECK (jsonb_typeof("data_request"."targetIds") = 'array' and jsonb_array_length("data_request"."targetIds") <= 50),
	CONSTRAINT "data_request_targets_only_evidence" CHECK ("data_request"."kind" in ('redact_evidence', 'delete_evidence') or jsonb_array_length("data_request"."targetIds") = 0),
	CONSTRAINT "data_request_note_len" CHECK ("data_request"."note" is null or char_length("data_request"."note") <= 200),
	CONSTRAINT "data_request_resolved_pair" CHECK (("data_request"."status" = 'pending') = ("data_request"."resolvedAt" is null))
);
--> statement-breakpoint
CREATE TABLE "self_exclusion" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"period" "self_exclusion_period" NOT NULL,
	"startsAt" timestamp with time zone DEFAULT now() NOT NULL,
	"endsAt" timestamp with time zone,
	"identityHashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_exclusion_ends_matches_period" CHECK (("self_exclusion"."period" = 'permanent') = ("self_exclusion"."endsAt" is null)),
	CONSTRAINT "self_exclusion_hashes_only_permanent" CHECK ("self_exclusion"."period" = 'permanent' or cardinality("self_exclusion"."identityHashes") = 0)
);
--> statement-breakpoint
CREATE TABLE "user_preference" (
	"userId" text PRIMARY KEY NOT NULL,
	"dailyDepositAlertUsdt" integer,
	"sessionAlertMinutes" integer,
	"nightAlert" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preference_deposit_range" CHECK ("user_preference"."dailyDepositAlertUsdt" is null or "user_preference"."dailyDepositAlertUsdt" between 1 and 1000000),
	CONSTRAINT "user_preference_session_range" CHECK ("user_preference"."sessionAlertMinutes" is null or "user_preference"."sessionAlertMinutes" between 15 and 1440)
);
--> statement-breakpoint
ALTER TABLE "user_brand_binding" ALTER COLUMN "operatorAccountId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD COLUMN "operatorAccountIdEnc" text;--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD COLUMN "operatorAccountIdMasked" text;--> statement-breakpoint
ALTER TABLE "data_request" ADD CONSTRAINT "data_request_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_exclusion" ADD CONSTRAINT "self_exclusion_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_request_user_idx" ON "data_request" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "data_request_status_idx" ON "data_request" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "self_exclusion_user_idx" ON "self_exclusion" USING btree ("userId","startsAt");--> statement-breakpoint
CREATE INDEX "self_exclusion_identity_hashes_gin" ON "self_exclusion" USING gin ("identityHashes");--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD CONSTRAINT "binding_account_enc_shape" CHECK ("user_brand_binding"."operatorAccountIdEnc" is null or "user_brand_binding"."operatorAccountIdEnc" ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD CONSTRAINT "binding_account_present" CHECK ("user_brand_binding"."operatorAccountId" is not null or ("user_brand_binding"."operatorAccountIdEnc" is not null and "user_brand_binding"."operatorAccountIdMasked" is not null));--> statement-breakpoint

-- A-011 / §7 v1.8 · D-012 #1：绑定账号字段级加密（过渡）。
-- 密钥不在库内，SQL 无法加密，故分两步：0008 加密文 / 掩码列、明文列改可空，新绑定只写密文（bydp_app 无明文列 INSERT 权限）；
-- 存量由 owner 运行 `pnpm --filter @bydp/db encrypt-bindings`（读 AUTH_PII_KEY）加密并置空明文；0009 删除明文列、密文 / 掩码改 NOT NULL。
-- 绑定身份列不可改（A-001 M1）扩展：密文 / 掩码 NULL → 值只允许一次；明文只允许在密文 + 掩码已就位时置空一次。
CREATE OR REPLACE FUNCTION bydp_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."boundAt" IS DISTINCT FROM OLD."boundAt" THEN
    RAISE EXCEPTION 'user_brand_binding.boundAt is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."brandId" IS DISTINCT FROM OLD."brandId"
     OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."operatorAccountIdHash" IS DISTINCT FROM OLD."operatorAccountIdHash"
     OR (OLD."operatorAccountIdEnc" IS NOT NULL AND NEW."operatorAccountIdEnc" IS DISTINCT FROM OLD."operatorAccountIdEnc")
     OR (OLD."operatorAccountIdMasked" IS NOT NULL AND NEW."operatorAccountIdMasked" IS DISTINCT FROM OLD."operatorAccountIdMasked")
     OR (NEW."operatorAccountId" IS DISTINCT FROM OLD."operatorAccountId"
         AND (NEW."operatorAccountId" IS NOT NULL OR NEW."operatorAccountIdEnc" IS NULL OR NEW."operatorAccountIdMasked" IS NULL)) THEN
    RAISE EXCEPTION 'user_brand_binding: userId/brandId/operatorAccountId/operatorAccountIdHash/operatorAccountIdEnc/operatorAccountIdMasked/source are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- bydp_app：收回表级 INSERT，按列授予（不含明文列）；UPDATE 列级授权不变（不含三列账号字段）
REVOKE INSERT ON "user_brand_binding" FROM bydp_app;--> statement-breakpoint
GRANT INSERT ("id", "userId", "brandId", "operatorAccountIdHash", "operatorAccountIdEnc", "operatorAccountIdMasked", "source", "promoCodeId",
              "boundAt", "verificationLevel", "postbackAt", "compensationEligible", "createdAt", "updatedAt") ON "user_brand_binding" TO bydp_app;--> statement-breakpoint

-- 自我排除：startsAt 服务端时间；endsAt 按 period 推出；permanent 由触发器快照本人全部身份盲索引（应用层传值一律覆盖，不可伪造）。
-- 只追加（owner 同拦）。「期内不可撤销」：生效判定取全部未到期行（core：存在 endsAt 为空或 > now() 的行），新插较短一档不会缩短既有排除。
CREATE OR REPLACE FUNCTION bydp_self_exclusion_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (coalesce(current_setting('bydp.allow_backfill', true), 'off') = 'on'
          AND current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = TG_TABLE_SCHEMA AND tablename = TG_TABLE_NAME)) THEN
    NEW."startsAt" := now();
  END IF;
  NEW."endsAt" := CASE WHEN NEW."period" = 'permanent' THEN NULL ELSE NEW."startsAt" + make_interval(days => NEW."period"::text::int) END;
  NEW."identityHashes" := CASE WHEN NEW."period" = 'permanent'
    THEN coalesce((SELECT array_agg(i."providerAccountId" ORDER BY i."providerAccountId") FROM "identity" i
                   WHERE i."userId" = NEW."userId" AND i."providerAccountId" IS NOT NULL), '{}'::text[])
    ELSE '{}'::text[] END;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS self_exclusion_fill ON "self_exclusion";--> statement-breakpoint
CREATE TRIGGER self_exclusion_fill BEFORE INSERT ON "self_exclusion" FOR EACH ROW EXECUTE FUNCTION bydp_self_exclusion_fill();--> statement-breakpoint
DROP TRIGGER IF EXISTS self_exclusion_append_only ON "self_exclusion";--> statement-breakpoint
CREATE TRIGGER self_exclusion_append_only BEFORE UPDATE OR DELETE ON "self_exclusion" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS self_exclusion_no_truncate ON "self_exclusion";--> statement-breakpoint
CREATE TRIGGER self_exclusion_no_truncate BEFORE TRUNCATE ON "self_exclusion" FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- permanent 自我排除的身份盲索引不可再注册到其他用户（注销匿名化后同一 TG / 邮箱重新注册也拒绝；本人追加身份不受影响）
-- 审核 A-011 D1：permanent 排除之后本人也不得新增快照外的身份（否则「换登录方式 → 注销 → 新身份被释放」即可绕过）
CREATE OR REPLACE FUNCTION bydp_identity_permanent_block() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW."providerAccountId" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "self_exclusion" s
       WHERE s."period" = 'permanent' AND s."identityHashes" @> ARRAY[NEW."providerAccountId"] AND s."userId" <> NEW."userId") THEN
    RAISE EXCEPTION 'identity: permanently self-excluded' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerAccountId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "self_exclusion" s WHERE s."period" = 'permanent' AND s."userId" = NEW."userId")
     AND NOT EXISTS (SELECT 1 FROM "self_exclusion" s
                     WHERE s."period" = 'permanent' AND s."userId" = NEW."userId" AND s."identityHashes" @> ARRAY[NEW."providerAccountId"]) THEN
    RAISE EXCEPTION 'identity: permanently self-excluded user cannot add identities' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS identity_permanent_block ON "identity";--> statement-breakpoint
CREATE TRIGGER identity_permanent_block BEFORE INSERT OR UPDATE OF "providerAccountId", "userId" ON "identity" FOR EACH ROW EXECUTE FUNCTION bydp_identity_permanent_block();--> statement-breakpoint

-- 数据请求：只有 status / resolvedAt / updatedAt 可变；status 只能 pending → done | rejected 一次；resolvedAt 由服务端置为 now()
CREATE OR REPLACE FUNCTION bydp_data_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."targetIds" IS DISTINCT FROM OLD."targetIds" OR NEW."note" IS DISTINCT FROM OLD."note" THEN
    RAISE EXCEPTION 'data_request: only status can change' USING ERRCODE = 'insufficient_privilege';
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
DROP TRIGGER IF EXISTS data_request_guard ON "data_request";--> statement-breakpoint
CREATE TRIGGER data_request_guard BEFORE UPDATE ON "data_request" FOR EACH ROW EXECUTE FUNCTION bydp_data_request_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS data_request_no_delete ON "data_request";--> statement-breakpoint
CREATE TRIGGER data_request_no_delete BEFORE DELETE ON "data_request" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS data_request_no_truncate ON "data_request";--> statement-breakpoint
CREATE TRIGGER data_request_no_truncate BEFORE TRUNCATE ON "data_request" FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖三张新表
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

-- 授权（scoring_ro 均不授权，白名单 15 张不变）
GRANT SELECT, INSERT ON "self_exclusion" TO bydp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "user_preference" TO bydp_app;--> statement-breakpoint
GRANT UPDATE ("dailyDepositAlertUsdt", "sessionAlertMinutes", "nightAlert", "updatedAt") ON "user_preference" TO bydp_app;--> statement-breakpoint
-- data_request：新建只能是待处理（status / resolvedAt 不在 INSERT 列内，取默认 pending / NULL）
GRANT SELECT ON "data_request" TO bydp_app;--> statement-breakpoint
GRANT INSERT ("id", "userId", "kind", "targetIds", "note", "createdAt", "updatedAt") ON "data_request" TO bydp_app;--> statement-breakpoint
GRANT UPDATE ("status", "resolvedAt", "updatedAt") ON "data_request" TO bydp_app;
