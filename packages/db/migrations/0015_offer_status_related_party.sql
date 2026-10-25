-- A-018 迁移 0015 预览 v2（双签 db，未落地；落地时原样写入 packages/db/migrations/0015_offer_status_related_party.sql）
-- 依据：§9.2 v1.15 / v1.17 · HANDOVER §9 #26 · 协调官 D-020 裁定 ④ · 审核 A-018 v1 复核（并发须先锁父行 + 命名 CONSTRAINT）
-- v1 → v2：① bydp_brand_certify_guard / bydp_offer_active_guard 先**无条件** FOR SHARE 锁父行再检查（READ COMMITTED 下
--            EXISTS 看不到对方未提交数据，FK 的 KEY SHARE 也不阻塞非键列更新）；
--            运营商侧守卫不反向锁品牌（行锁已与品牌侧 FOR SHARE 互斥，反向锁会交叉死锁）；
--          ② RAISE 带命名 CONSTRAINT（brand_related_party_never_certified / offer_blacklisted_brand_inactive），api 按 err.constraint 精确映射 409。
-- 生成部分（drizzle-kit generate，未改动）：前两条语句
CREATE TYPE "public"."offer_status" AS ENUM('active', 'offline');--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "status" "offer_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint

-- ===================== 手写部分 =====================

-- 1) 前置断言：存量数据不得已违反「关联方永不认证」——违反则迁移失败，由人工先处理，不静默改数据
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "brand" b JOIN "operator" o ON o."id" = b."operatorId" WHERE b."status" = 'certified' AND o."relatedParty") THEN
    RAISE EXCEPTION 'A-018 precheck: certified brand under a related-party operator exists; resolve manually before migrating';
  END IF;
END $$;--> statement-breakpoint

-- 2) 存量回填：已在黑名单的品牌，其 Offer 置 offline（与此前「按品牌状态过滤」的展示结果一致）
UPDATE "offer" o SET "status" = 'offline', "updatedAt" = now()
  FROM "brand" b WHERE b."id" = o."brandId" AND b."status" = 'blacklist' AND o."status" = 'active';--> statement-breakpoint

-- 3) #26 关联方品牌永不认证（ADR-0003 / 架构 §5 · §14）：owner 同样拦；并发安全（先锁父行）
--    a. 品牌侧：新建或改为 certified，或认证品牌改挂运营商 → 先 FOR SHARE 锁运营商行（与运营商侧改关联方的行锁互斥），再检查
CREATE OR REPLACE FUNCTION bydp_brand_certify_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'certified' THEN
    PERFORM 1 FROM "operator" WHERE "id" = NEW."operatorId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM "operator" o WHERE o."id" = NEW."operatorId" AND o."relatedParty") THEN
      RAISE EXCEPTION 'brand %: related-party operator can never be certified (ADR-0003)', NEW."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'brand_related_party_never_certified';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS brand_certify_guard ON "brand";--> statement-breakpoint
CREATE TRIGGER brand_certify_guard BEFORE INSERT OR UPDATE OF "status", "operatorId" ON "brand"
  FOR EACH ROW EXECUTE FUNCTION bydp_brand_certify_guard();--> statement-breakpoint

--    b. 运营商侧：名下有认证品牌时不得改为关联方（否则绕过 a）。本 UPDATE 已持该运营商行锁，与 a 的 FOR SHARE 互斥：
--       a 先拿到共享锁 → 本更新等其提交后再查，能看到已认证；本更新先拿到行锁 → a 等待后看到关联方而拒绝。
--       此处不再反向锁品牌行（会与 a「持品牌行锁等运营商」交叉成死锁）
CREATE OR REPLACE FUNCTION bydp_operator_related_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."relatedParty" AND NOT COALESCE(OLD."relatedParty", false) THEN
    IF EXISTS (SELECT 1 FROM "brand" b WHERE b."operatorId" = NEW."id" AND b."status" = 'certified') THEN
      RAISE EXCEPTION 'operator %: has certified brands; demote them before marking related party (ADR-0003)', NEW."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'brand_related_party_never_certified';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS operator_related_guard ON "operator";--> statement-breakpoint
CREATE TRIGGER operator_related_guard BEFORE UPDATE OF "relatedParty" ON "operator"
  FOR EACH ROW EXECUTE FUNCTION bydp_operator_related_guard();--> statement-breakpoint

-- 4) Offer 独立状态
--    a. 品牌转入黑名单 → 同事务该品牌全部 Offer 置 offline；解除黑名单不自动恢复（人工逐个上线，admin，写 audit）
CREATE OR REPLACE FUNCTION bydp_offer_offline_on_blacklist() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "offer" SET "status" = 'offline', "updatedAt" = now() WHERE "brandId" = NEW."id" AND "status" = 'active';
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS brand_blacklist_offer_offline ON "brand";--> statement-breakpoint
CREATE TRIGGER brand_blacklist_offer_offline AFTER UPDATE OF "status" ON "brand"
  FOR EACH ROW WHEN (NEW."status" = 'blacklist' AND OLD."status" IS DISTINCT FROM 'blacklist') EXECUTE FUNCTION bydp_offer_offline_on_blacklist();--> statement-breakpoint

--    b. 黑名单品牌的 Offer 不得为 active（新建 / 上线 / 改挂品牌都拦；owner 同样拦）——先 FOR SHARE 锁品牌行（与拉黑的品牌行锁互斥）再检查
CREATE OR REPLACE FUNCTION bydp_offer_active_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'active' THEN
    PERFORM 1 FROM "brand" WHERE "id" = NEW."brandId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM "brand" b WHERE b."id" = NEW."brandId" AND b."status" = 'blacklist') THEN
      RAISE EXCEPTION 'offer %: brand is blacklisted; offer must stay offline', NEW."id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'offer_blacklisted_brand_inactive';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS offer_active_guard ON "offer";--> statement-breakpoint
CREATE TRIGGER offer_active_guard BEFORE INSERT OR UPDATE OF "status", "brandId" ON "offer"
  FOR EACH ROW EXECUTE FUNCTION bydp_offer_active_guard();

-- 授权不变：bydp_app 对 offer / brand / operator 的既有表级权限覆盖新列与 FOR SHARE（需 UPDATE 权限，已具备）；
-- bydp_agent / bydp_scoring_ro 不可读 offer（白名单不变）。无新表，无需重跑 createdAt 触发器循环。
