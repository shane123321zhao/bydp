CREATE TABLE "identity_block" (
	"id" text PRIMARY KEY NOT NULL,
	"identityHash" text NOT NULL,
	"blockedUntil" timestamp with time zone,
	"requestId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_block_hash_hex" CHECK ("identity_block"."identityHash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "identity_block" ADD CONSTRAINT "identity_block_requestId_data_request_id_fk" FOREIGN KEY ("requestId") REFERENCES "public"."data_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_block_hash_idx" ON "identity_block" USING btree ("identityHash");--> statement-breakpoint
-- ==================== A-016 手写部分 ====================

-- ① identity_block 只追加（UPDATE / DELETE / TRUNCATE，表 owner 同样受约束）；只由 bydp_anonymize_user 写入，bydp_app / scoring_ro 无任何权限
DROP TRIGGER IF EXISTS identity_block_append_only ON "identity_block";--> statement-breakpoint
CREATE TRIGGER identity_block_append_only BEFORE UPDATE OR DELETE ON "identity_block" FOR EACH ROW EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS identity_block_no_truncate ON "identity_block";--> statement-breakpoint
CREATE TRIGGER identity_block_no_truncate BEFORE TRUNCATE ON "identity_block" FOR EACH STATEMENT EXECUTE FUNCTION bydp_forbid_mutation();--> statement-breakpoint
REVOKE ALL ON "identity_block" FROM bydp_app;--> statement-breakpoint
REVOKE ALL ON "identity_block" FROM bydp_scoring_ro;--> statement-breakpoint

-- ② 身份注册拦截：在 0008 两条（permanent 快照拦他人 / permanent 用户不得新增快照外身份）之外，再查 identity_block（未到期或永久）
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
  IF NEW."providerAccountId" IS NOT NULL AND EXISTS (
       SELECT 1 FROM "identity_block" b
       WHERE b."identityHash" = NEW."providerAccountId" AND (b."blockedUntil" IS NULL OR b."blockedUntil" > now())) THEN
    RAISE EXCEPTION 'identity: blocked until self-exclusion ends (account was anonymized during exclusion)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ③ 投诉原文写入后不可改（表 owner 同样受约束）；唯一例外：注销函数内用公开陈述覆盖已结案案件的原文（§9.2 v1.11）
CREATE OR REPLACE FUNCTION bydp_complaint_description_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."description" IS DISTINCT FROM OLD."description" AND NOT bydp_in_anonymize() THEN
    RAISE EXCEPTION 'complaint.description is immutable (only overwritten by bydp_anonymize_user)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS complaint_description_guard ON "complaint";--> statement-breakpoint
CREATE TRIGGER complaint_description_guard BEFORE UPDATE ON "complaint" FOR EACH ROW EXECUTE FUNCTION bydp_complaint_description_guard();--> statement-breakpoint

-- ④ 窄窗串行化（审核 A-015 落地确认）：新建投诉 / 自我排除 / 数据请求 / 绑定先对 app_user 行加共享锁，
--    与注销执行的 FOR UPDATE 互斥；拿到锁后若用户已注销则拒绝（不会在注销之后穿插写入）
CREATE OR REPLACE FUNCTION bydp_lock_live_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a timestamptz; found_user boolean;
BEGIN
  SELECT u."anonymizedAt", true INTO a, found_user FROM "app_user" u WHERE u."id" = NEW."userId" FOR SHARE;
  IF found_user AND a IS NOT NULL THEN
    RAISE EXCEPTION 'app_user %: anonymized', NEW."userId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS complaint_lock_live_user ON "complaint";--> statement-breakpoint
CREATE TRIGGER complaint_lock_live_user BEFORE INSERT ON "complaint" FOR EACH ROW EXECUTE FUNCTION bydp_lock_live_user();--> statement-breakpoint
DROP TRIGGER IF EXISTS self_exclusion_lock_live_user ON "self_exclusion";--> statement-breakpoint
CREATE TRIGGER self_exclusion_lock_live_user BEFORE INSERT ON "self_exclusion" FOR EACH ROW EXECUTE FUNCTION bydp_lock_live_user();--> statement-breakpoint
DROP TRIGGER IF EXISTS data_request_lock_live_user ON "data_request";--> statement-breakpoint
CREATE TRIGGER data_request_lock_live_user BEFORE INSERT ON "data_request" FOR EACH ROW EXECUTE FUNCTION bydp_lock_live_user();--> statement-breakpoint
DROP TRIGGER IF EXISTS binding_lock_live_user ON "user_brand_binding";--> statement-breakpoint
CREATE TRIGGER binding_lock_live_user BEFORE INSERT ON "user_brand_binding" FOR EACH ROW EXECUTE FUNCTION bydp_lock_live_user();--> statement-breakpoint

-- ⑤ 互斥触发器 UPDATE 修正（审核 A-015 小项）：复核时排除被更新的本行旧值，避免 arbitrator ↔ commerce 以外的 UPDATE 被误拦
CREATE OR REPLACE FUNCTION bydp_user_role_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bydp:user_role'));
  IF NEW."roleKey" IN ('arbitrator', 'commerce') AND EXISTS (
       SELECT 1 FROM "user_role" r
       WHERE r."userId" = NEW."userId"
         AND r."roleKey" = (CASE NEW."roleKey" WHEN 'arbitrator' THEN 'commerce' ELSE 'arbitrator' END)::role_key
         AND NOT (TG_OP = 'UPDATE' AND r."userId" = OLD."userId" AND r."roleKey" = OLD."roleKey")) THEN
    RAISE EXCEPTION 'user_role: arbitrator and commerce are mutually exclusive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ⑥ 注销函数 v2（签名不变，0012 v1 的全部行为保留）：
--    + 开头先锁 app_user（FOR UPDATE，与 ④ 互斥），再锁请求行；
--    + DB 层兜底：有未结案投诉（resolved / rejected / exposed 以外）→ 拒绝（core 另以 409 open_complaints 提示）；
--    + 有 permanent 排除 → 身份哈希写 identity_block（blockedUntil = null）；有生效中的临时排除 → blockedUntil = 最晚 endsAt；
--    + 已结案案件：证据原文置删除（deletedAt + storageKey = null，哈希保留），description 用 publicDescription 覆盖、无则「（已注销）」；
--      未公开案件的 title 同样置「（已注销）」（审核 A-016 E1：标题也是用户输入，可能含姓名 / 联系方式）；
--      被删对象的 key 随返回值交给 core——core 同事务写 evidence_delete_original audit，提交后删对象与预览缓存（对账任务兜底）。
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
                            'identityBlocks', n_block, 'descriptionsOverwritten', n_desc, 'evidenceDeleted', n_ev, 'evidenceKeys', v_keys);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION bydp_anonymize_user(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION bydp_anonymize_user(text, text) TO bydp_app;--> statement-breakpoint

-- 规则（rules/db-migration.md）：重跑 createdAt 触发器循环，覆盖新表 identity_block
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
