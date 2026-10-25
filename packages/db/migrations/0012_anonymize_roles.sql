ALTER TABLE "points_event" DROP CONSTRAINT "points_event_positive";--> statement-breakpoint
DROP INDEX "binding_brand_account_hash_uq";--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD COLUMN "revokedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "anonymizedAt" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "review_item_pending_subject_uq" ON "review_item" USING btree ("kind","subject") WHERE "review_item"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "binding_brand_account_hash_uq" ON "user_brand_binding" USING btree ("brandId","operatorAccountIdHash") WHERE "user_brand_binding"."revokedAt" is null;--> statement-breakpoint
ALTER TABLE "points_event" ADD CONSTRAINT "points_event_sign" CHECK ("points_event"."points" > 0 or ("points_event"."event" = 'anonymize_reversal' and "points_event"."points" < 0)) NOT VALID;--> statement-breakpoint

-- ==================== A-015 手写部分 ====================

-- ① 角色参照四行（0000–0011 无种子，W3#046）
INSERT INTO "role" ("key", "name") VALUES ('arbitrator', '仲裁员'), ('commerce', '商务'), ('editor', '编辑'), ('admin', '管理员')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- ② 仲裁员与商务互斥（ADR-0003 物理隔离）：DB 兜底，与 core / CLI 同一把咨询锁串行，并发两笔也不能同时成立（表 owner 同样受约束）
CREATE OR REPLACE FUNCTION bydp_user_role_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bydp:user_role'));
  IF NEW."roleKey" IN ('arbitrator', 'commerce') AND EXISTS (
       SELECT 1 FROM "user_role" r
       WHERE r."userId" = NEW."userId"
         AND r."roleKey" = (CASE NEW."roleKey" WHEN 'arbitrator' THEN 'commerce' ELSE 'arbitrator' END)::role_key) THEN
    RAISE EXCEPTION 'user_role: arbitrator and commerce are mutually exclusive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS user_role_exclusive ON "user_role";--> statement-breakpoint
CREATE TRIGGER user_role_exclusive BEFORE INSERT OR UPDATE ON "user_role" FOR EACH ROW EXECUTE FUNCTION bydp_user_role_exclusive();--> statement-breakpoint

-- ③ 注销上下文：只有以表 owner 身份（即 SECURITY DEFINER 的 bydp_anonymize_user 内）且事务内置位 bydp.anonymize 时为真。
--    自定义参数任何会话都能 SET，故以 owner 身份为真正闸门（与 bydp.allow_backfill / bydp.points_apply 同一口径）；bydp_app 永远为假。
CREATE OR REPLACE FUNCTION bydp_in_anonymize() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('bydp.anonymize', true), '') <> ''
     AND current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'app_user')
$$;--> statement-breakpoint

-- ④ 积分冲销：anonymize_reversal 只能在注销上下文内写，分值由触发器取「负的当前余额」（调用方不能自定），dedupeKey 须为 anonymize:<request_id>；
--    其余事件照旧按生效规则定分值。points_event FK 指向 points_rule，故补一行停用的参照行（分值 0、active = false，规则路径永远拒绝该事件）。
INSERT INTO "points_rule" ("event", "points", "active") VALUES ('anonymize_reversal', 0, false) ON CONFLICT ("event") DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bydp_points_event_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  IF NEW."event" = 'anonymize_reversal' THEN
    IF NOT bydp_in_anonymize() OR NEW."dedupeKey" IS DISTINCT FROM 'anonymize:' || current_setting('bydp.anonymize', true) THEN
      RAISE EXCEPTION 'points_event: anonymize_reversal only via bydp_anonymize_user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT -u."points" INTO p FROM "app_user" u WHERE u."id" = NEW."userId";
    IF p IS NULL OR p >= 0 THEN
      RAISE EXCEPTION 'points_event: nothing to reverse' USING ERRCODE = 'check_violation';
    END IF;
    NEW."points" := p;
    RETURN NEW;
  END IF;
  SELECT r."points" INTO p FROM "points_rule" r WHERE r."event" = NEW."event" AND r."active";
  IF p IS NULL THEN
    RAISE EXCEPTION 'points_event: rule % is not active', NEW."event" USING ERRCODE = 'check_violation';
  END IF;
  NEW."points" := p;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ⑤ 绑定失效：revokedAt 只能在注销上下文内由 NULL 写一次（取服务端时间），之后不可改；其余身份列不可改照旧（0002 / 0008 口径）
CREATE OR REPLACE FUNCTION bydp_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."boundAt" IS DISTINCT FROM OLD."boundAt" THEN
    RAISE EXCEPTION 'user_brand_binding.boundAt is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."brandId" IS DISTINCT FROM OLD."brandId"
     OR NEW."operatorAccountIdEnc" IS DISTINCT FROM OLD."operatorAccountIdEnc"
     OR NEW."operatorAccountIdMasked" IS DISTINCT FROM OLD."operatorAccountIdMasked" OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."operatorAccountIdHash" IS DISTINCT FROM OLD."operatorAccountIdHash" THEN
    RAISE EXCEPTION 'user_brand_binding: userId/brandId/operatorAccountIdHash/operatorAccountIdEnc/operatorAccountIdMasked/source are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    IF OLD."revokedAt" IS NOT NULL OR NOT bydp_in_anonymize() THEN
      RAISE EXCEPTION 'user_brand_binding.revokedAt: write-once, only via bydp_anonymize_user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."revokedAt" := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ⑥ app_user.anonymizedAt：只能在注销上下文内由 NULL 写一次（服务端时间）；匿名化之后昵称 / 地区 / 语言不可再改
CREATE OR REPLACE FUNCTION bydp_user_anonymized_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt" THEN
    IF OLD."anonymizedAt" IS NOT NULL OR NOT bydp_in_anonymize() THEN
      RAISE EXCEPTION 'app_user.anonymizedAt: write-once, only via bydp_anonymize_user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW."anonymizedAt" := now();
  ELSIF OLD."anonymizedAt" IS NOT NULL
        AND (NEW."displayName" IS DISTINCT FROM OLD."displayName" OR NEW."region" IS DISTINCT FROM OLD."region"
             OR NEW."locale" IS DISTINCT FROM OLD."locale") THEN
    RAISE EXCEPTION 'app_user: anonymized user profile is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS app_user_anonymized_guard ON "app_user";--> statement-breakpoint
CREATE TRIGGER app_user_anonymized_guard BEFORE UPDATE ON "app_user" FOR EACH ROW EXECUTE FUNCTION bydp_user_anonymized_guard();--> statement-breakpoint

-- ⑦ 注销匿名化（§9.2 v1.10）：owner 级 SECURITY DEFINER，单事务（随调用方事务）。前置：本人的 anonymize 请求待处理且已联系确认。
--    保留：只追加表的行与外键、complaint / click / conversion / commission / status_history / data_request / self_exclusion（含快照）。
--    抹除：identity（含联系方式密文）、user_preference、subscription、notification、user_role；昵称「已注销用户」、地区置空；会话纪元 +1（已签发会话立即失效）。
--    bydp_app 只有 EXECUTE；守卫例外只在本函数体内成立（bydp_in_anonymize）。不写 audit_log（由调用方 core 同事务写，带 actor）。
CREATE OR REPLACE FUNCTION bydp_anonymize_user(p_user_id text, p_request_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  req record;
  bal integer;
  n_bind integer; n_ident integer; n_pref integer; n_sub integer; n_notif integer; n_role integer;
BEGIN
  SELECT r."userId", r."kind", r."status", r."contactChannel" INTO req FROM "data_request" r WHERE r."id" = p_request_id FOR UPDATE;
  IF NOT FOUND OR req."userId" IS DISTINCT FROM p_user_id OR req."kind" <> 'anonymize' OR req."status" <> 'pending' THEN
    RAISE EXCEPTION 'anonymize: no pending anonymize request % for user', p_request_id USING ERRCODE = 'check_violation';
  END IF;
  IF req."contactChannel" IS NULL THEN
    RAISE EXCEPTION 'anonymize: contact confirmation required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT u."points" INTO bal FROM "app_user" u WHERE u."id" = p_user_id AND u."anonymizedAt" IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anonymize: user missing or already anonymized' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('bydp.anonymize', p_request_id, true);

  IF bal > 0 THEN
    INSERT INTO "points_event" ("id", "userId", "event", "points", "refType", "refId", "dedupeKey")
    VALUES ('pe_' || replace(gen_random_uuid()::text, '-', ''), p_user_id, 'anonymize_reversal', -bal, 'data_request', p_request_id, 'anonymize:' || p_request_id);
  END IF;

  UPDATE "user_brand_binding" SET "revokedAt" = now(), "compensationEligible" = false, "updatedAt" = now()
  WHERE "userId" = p_user_id AND "revokedAt" IS NULL;
  GET DIAGNOSTICS n_bind = ROW_COUNT;

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
                            'preferences', n_pref, 'subscriptions', n_sub, 'notifications', n_notif, 'roles', n_role);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION bydp_anonymize_user(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION bydp_anonymize_user(text, text) TO bydp_app;--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环（本迁移无新表，循环保持幂等）
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

-- 授权：revokedAt / anonymizedAt 不授予 bydp_app（列级 INSERT / UPDATE 列表不变，只能经函数写）；scoring_ro 白名单不变
REVOKE UPDATE ("revokedAt") ON "user_brand_binding" FROM bydp_app;--> statement-breakpoint
REVOKE UPDATE ("anonymizedAt") ON "app_user" FROM bydp_app;
