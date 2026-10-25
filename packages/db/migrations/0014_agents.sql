CREATE TABLE "candidate_query" (
	"id" text PRIMARY KEY NOT NULL,
	"candidateId" text NOT NULL,
	"viewerHash" text NOT NULL,
	"day" date NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_query_viewer_hex" CHECK ("candidate_query"."viewerHash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "site_check" (
	"id" text PRIMARY KEY NOT NULL,
	"identifierId" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"checkedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"httpStatus" integer,
	"finalHost" text,
	"contentHash" text,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_check_kind" CHECK ("site_check"."kind" in ('home', 'terms')),
	CONSTRAINT "site_check_hash_hex" CHECK ("site_check"."contentHash" is null or "site_check"."contentHash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "site_check_status_range" CHECK ("site_check"."httpStatus" is null or "site_check"."httpStatus" between 100 and 599),
	CONSTRAINT "site_check_error_len" CHECK ("site_check"."error" is null or char_length("site_check"."error") <= 200),
	CONSTRAINT "site_check_outcome" CHECK (("site_check"."httpStatus" is null) <> ("site_check"."error" is null))
);
--> statement-breakpoint
ALTER TABLE "candidate" ALTER COLUMN "weightedPriority" SET DATA TYPE numeric(10, 4);--> statement-breakpoint
ALTER TABLE "brand_attribute" ADD COLUMN "sourceUrl" text;--> statement-breakpoint
ALTER TABLE "brand_attribute" ADD COLUMN "sourceFetchedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_attribute" ADD COLUMN "reviewItemId" text;--> statement-breakpoint
ALTER TABLE "candidate_query" ADD CONSTRAINT "candidate_query_candidateId_candidate_id_fk" FOREIGN KEY ("candidateId") REFERENCES "public"."candidate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_check" ADD CONSTRAINT "site_check_identifierId_identifier_id_fk" FOREIGN KEY ("identifierId") REFERENCES "public"."identifier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_query_viewer_day_uq" ON "candidate_query" USING btree ("candidateId","viewerHash","day");--> statement-breakpoint
CREATE INDEX "candidate_query_day_idx" ON "candidate_query" USING btree ("day");--> statement-breakpoint
CREATE INDEX "site_check_identifier_idx" ON "site_check" USING btree ("identifierId","kind","checkedAt");--> statement-breakpoint
-- ==================== A-017 手写部分 ====================

-- ① Agent 专用角色（§13 v1.12 ①：Agent 进程只持 bydp_app 之下的只读 + review_item 写权限）。密码带外设置（bootstrap，与 bydp_app 同法）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bydp_agent') THEN CREATE ROLE bydp_agent LOGIN; END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bydp_agent;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO bydp_agent;--> statement-breakpoint
-- 读：品牌（不含保证金等商业列）/ 标识 / 品牌属性 / 内容（本地化源）/ review_item（去重）
GRANT SELECT ("id", "operatorId", "slug", "name", "status", "statusSince", "logoUrl", "markets", "createdAt", "updatedAt") ON "brand" TO bydp_agent;--> statement-breakpoint
GRANT SELECT ON "identifier", "brand_attribute", "content", "review_item" TO bydp_agent;--> statement-breakpoint
-- 读：投诉初筛规则所需列（不含 title / description / publicDescription 等用户自由文本；LLM 补充意见另行裁定后再授权）
GRANT SELECT ("id", "brandId", "userId", "category", "amountUsdt", "eventDate", "status", "createdAt") ON "complaint" TO bydp_agent;--> statement-breakpoint
-- 读：同设备规则（设备盲索引与账号归属，不含时间以外的任何身份信息）
GRANT SELECT ("userId", "fingerprint") ON "device" TO bydp_agent;--> statement-breakpoint
-- 写：只能新建待决提议（status / 决定字段不在列内）与站点监控记录
GRANT INSERT ("id", "kind", "subject", "proposal", "source", "createdAt") ON "review_item" TO bydp_agent;--> statement-breakpoint
GRANT SELECT ON "site_check" TO bydp_agent;--> statement-breakpoint
GRANT INSERT ("id", "identifierId", "kind", "url", "checkedAt", "httpStatus", "finalHost", "contentHash", "error", "createdAt") ON "site_check" TO bydp_agent;--> statement-breakpoint

-- ② 新表授权：bydp_app 读写 candidate_query（/check 未收录查询计数）、读 + 清理 site_check（worker 保留期清理）；均不可改已写行
REVOKE ALL ON "candidate_query", "site_check" FROM bydp_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "candidate_query" TO bydp_app;--> statement-breakpoint
GRANT SELECT, DELETE ON "site_check" TO bydp_app;--> statement-breakpoint
-- scoring_ro 白名单不变（新表不授权）
REVOKE ALL ON "candidate_query", "site_check" FROM bydp_scoring_ro;--> statement-breakpoint

-- ③ 服务端时间：site_check.checkedAt 一律取 DB 时间（Agent 不能伪造抓取时刻；owner + allow_backfill 例外同 0002）
DROP TRIGGER IF EXISTS site_check_server_ts ON "site_check";--> statement-breakpoint
CREATE TRIGGER site_check_server_ts BEFORE INSERT ON "site_check" FOR EACH ROW EXECUTE FUNCTION bydp_server_ts('checkedAt');--> statement-breakpoint
-- 已写行不可改（表 owner 同样受约束）；删除只用于保留期清理
DROP TRIGGER IF EXISTS site_check_no_update ON "site_check";--> statement-breakpoint
CREATE TRIGGER site_check_no_update BEFORE UPDATE ON "site_check" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS candidate_query_no_update ON "candidate_query";--> statement-breakpoint
CREATE TRIGGER candidate_query_no_update BEFORE UPDATE ON "candidate_query" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- ④ brand_attribute 来源列：只能随 source = 'agent' 写入（人工录入不得伪造来源）
ALTER TABLE "brand_attribute" ADD CONSTRAINT "brand_attribute_source_url_agent" CHECK (("sourceUrl" is null and "sourceFetchedAt" is null) or "source" = 'agent');--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖新表 candidate_query / site_check
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
