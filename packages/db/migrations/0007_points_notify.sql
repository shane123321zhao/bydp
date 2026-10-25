CREATE TABLE "points_event" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"event" text NOT NULL,
	"points" integer NOT NULL,
	"refType" text NOT NULL,
	"refId" text NOT NULL,
	"dedupeKey" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_event_positive" CHECK ("points_event"."points" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "deliveredAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "channel" "notify_channel";--> statement-breakpoint
ALTER TABLE "points_event" ADD CONSTRAINT "points_event_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_event" ADD CONSTRAINT "points_event_event_points_rule_event_fk" FOREIGN KEY ("event") REFERENCES "public"."points_rule"("event") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "points_event_dedupe_uq" ON "points_event" USING btree ("dedupeKey");--> statement-breakpoint
CREATE INDEX "points_event_user_idx" ON "points_event" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "points_event_ref_idx" ON "points_event" USING btree ("refType","refId");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_delivery_pair" CHECK (("notification"."deliveredAt" is null) = ("notification"."channel" is null));--> statement-breakpoint

-- A-010 / §9.2 v1.7：积分规则种子（已存在的规则不覆盖；积分只从生效日起累计，不追溯）
INSERT INTO "points_rule" ("event", "points", "active") VALUES
  ('binding_confirmed', 500, true),
  ('withdrawal_report_accepted', 50, true),
  ('review_published', 20, true),
  ('complaint_resolved', 100, true)
ON CONFLICT ("event") DO NOTHING;--> statement-breakpoint

-- 分值以规则为准：插入时用当前生效规则覆盖 points；规则不存在或已停用 → 拒绝（应用层不能自定分值）
CREATE OR REPLACE FUNCTION bydp_points_event_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  SELECT r."points" INTO p FROM "points_rule" r WHERE r."event" = NEW."event" AND r."active";
  IF p IS NULL THEN
    RAISE EXCEPTION 'points_event: rule % is not active', NEW."event" USING ERRCODE = 'check_violation';
  END IF;
  NEW."points" := p;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS points_event_rule ON "points_event";--> statement-breakpoint
CREATE TRIGGER points_event_rule BEFORE INSERT ON "points_event" FOR EACH ROW EXECUTE FUNCTION bydp_points_event_rule();--> statement-breakpoint

-- 余额为派生缓存：事件插入后累加 app_user.points 并按门槛重算 level（0 / 500 / 1500 / 3000 / 6000）
CREATE OR REPLACE FUNCTION bydp_points_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('bydp.points_apply', 'on', true);
  UPDATE "app_user" u SET
    "points" = u."points" + NEW."points",
    "level" = CASE WHEN u."points" + NEW."points" >= 6000 THEN 5 WHEN u."points" + NEW."points" >= 3000 THEN 4
                   WHEN u."points" + NEW."points" >= 1500 THEN 3 WHEN u."points" + NEW."points" >= 500 THEN 2 ELSE 1 END
  WHERE u."id" = NEW."userId";
  PERFORM set_config('bydp.points_apply', 'off', true);
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS points_event_apply ON "points_event";--> statement-breakpoint
CREATE TRIGGER points_event_apply AFTER INSERT ON "points_event" FOR EACH ROW EXECUTE FUNCTION bydp_points_apply();--> statement-breakpoint

-- points_event 只追加（UPDATE / DELETE / TRUNCATE，表 owner 同样受约束）
DROP TRIGGER IF EXISTS points_event_append_only ON "points_event";--> statement-breakpoint
CREATE TRIGGER points_event_append_only BEFORE UPDATE OR DELETE ON "points_event" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS points_event_no_truncate ON "points_event";--> statement-breakpoint
CREATE TRIGGER points_event_no_truncate BEFORE TRUNCATE ON "points_event" FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint

-- 一次性对齐（协调官 A-010 #1 / 审核附带提示）：现有用户的 level 按门槛从 points 重算（守卫创建之前执行）
UPDATE "app_user" SET "level" = CASE WHEN "points" >= 6000 THEN 5 WHEN "points" >= 3000 THEN 4 WHEN "points" >= 1500 THEN 3 WHEN "points" >= 500 THEN 2 ELSE 1 END
WHERE "level" IS DISTINCT FROM (CASE WHEN "points" >= 6000 THEN 5 WHEN "points" >= 3000 THEN 4 WHEN "points" >= 1500 THEN 3 WHEN "points" >= 500 THEN 2 ELSE 1 END);--> statement-breakpoint

-- 余额不能手工改（审核 A-010 C1 / C3）：
--   UPDATE：只有在积分触发器内部（pg_trigger_depth() >= 2）且事务内已置位 bydp.points_apply 时才允许改 points / level——
--           单靠自定义参数不够（任何会话都能 SET），表 owner 同样受约束；
--   INSERT：非表 owner 新建用户不得自带积分 / 等级（points 须为 0、level 须为 1）；seed 以 owner 身份运行不受影响。
CREATE OR REPLACE FUNCTION bydp_user_points_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW."points" <> 0 OR NEW."level" <> 1)
       AND current_user <> (SELECT tableowner FROM pg_tables WHERE schemaname = TG_TABLE_SCHEMA AND tablename = TG_TABLE_NAME) THEN
      RAISE EXCEPTION 'app_user: new users start with 0 points / level 1' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."points" IS DISTINCT FROM OLD."points" OR NEW."level" IS DISTINCT FROM OLD."level")
     AND (pg_trigger_depth() < 2 OR coalesce(current_setting('bydp.points_apply', true), 'off') <> 'on') THEN
    RAISE EXCEPTION 'app_user.points / level are derived from points_event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS app_user_points_guard ON "app_user";--> statement-breakpoint
CREATE TRIGGER app_user_points_guard BEFORE INSERT OR UPDATE ON "app_user" FOR EACH ROW EXECUTE FUNCTION bydp_user_points_guard();--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖新表 points_event
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

-- 授权：points_event 只给 bydp_app SELECT / INSERT（只追加）；scoring_ro 不授权（白名单 15 张不变）
GRANT SELECT, INSERT ON "points_event" TO bydp_app;--> statement-breakpoint
-- app_user：收回表级 INSERT / UPDATE，只按列授予（points / level 不在内；审核 A-010 C1 双保险）
REVOKE INSERT, UPDATE ON "app_user" FROM bydp_app;--> statement-breakpoint
GRANT INSERT ("id", "displayName", "joinedAt", "region", "locale", "selfExcludedUntil", "sessionEpoch", "createdAt", "updatedAt") ON "app_user" TO bydp_app;--> statement-breakpoint
GRANT UPDATE ("displayName", "region", "locale", "selfExcludedUntil", "sessionEpoch", "updatedAt") ON "app_user" TO bydp_app;--> statement-breakpoint
-- points_rule：P1 规则只经迁移修改（审核 A-010 C2）；GET /config/points 只读不受影响
REVOKE INSERT, UPDATE, DELETE ON "points_rule" FROM bydp_app;
