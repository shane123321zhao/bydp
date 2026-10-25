-- A-012 前置：存量须已由 encrypt-bindings 加密回填（剩余明文 0、密文与掩码齐全），否则中止迁移、不删明文列
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_brand_binding"
             WHERE "operatorAccountId" IS NOT NULL OR "operatorAccountIdEnc" IS NULL OR "operatorAccountIdMasked" IS NULL) THEN
    RAISE EXCEPTION 'A-012: user_brand_binding 仍有未加密或明文未清空的行，请先运行 encrypt-bindings（剩余 0 后再迁移）';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "user_brand_binding" DROP CONSTRAINT "binding_account_present";--> statement-breakpoint
ALTER TABLE "user_brand_binding" ALTER COLUMN "operatorAccountIdEnc" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_brand_binding" ALTER COLUMN "operatorAccountIdMasked" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "skippedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "skipReason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "data_request_pending_uq" ON "data_request" USING btree ("userId","kind") WHERE "data_request"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "user_brand_binding" DROP COLUMN "operatorAccountId";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "selfExcludedUntil";--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_skip_pair" CHECK (("notification"."skippedAt" is null) = ("notification"."skipReason" is null));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_skip_reason" CHECK ("notification"."skipReason" is null or "notification"."skipReason" in ('tg_blocked', 'no_contact'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_delivered_xor_skipped" CHECK ("notification"."deliveredAt" is null or "notification"."skippedAt" is null);--> statement-breakpoint

-- 绑定身份列不可改（A-001 M1 · A-011 扩展）：明文列已删除，守卫去掉明文分支；密文 / 掩码已 NOT NULL，写入后一律不可改
CREATE OR REPLACE FUNCTION bydp_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."boundAt" IS DISTINCT FROM OLD."boundAt" THEN
    RAISE EXCEPTION 'user_brand_binding.boundAt is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."brandId" IS DISTINCT FROM OLD."brandId"
     OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."operatorAccountIdHash" IS DISTINCT FROM OLD."operatorAccountIdHash"
     OR NEW."operatorAccountIdEnc" IS DISTINCT FROM OLD."operatorAccountIdEnc"
     OR NEW."operatorAccountIdMasked" IS DISTINCT FROM OLD."operatorAccountIdMasked" THEN
    RAISE EXCEPTION 'user_brand_binding: userId/brandId/operatorAccountIdHash/operatorAccountIdEnc/operatorAccountIdMasked/source are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
