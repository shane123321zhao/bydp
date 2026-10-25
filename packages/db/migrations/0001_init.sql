CREATE TYPE "public"."brand_status" AS ENUM('certified', 'watch', 'blacklist');--> statement-breakpoint
CREATE TYPE "public"."complaint_category" AS ENUM('refused', 'delay', 'frozen', 'bonus', 'closed');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('screening', 'accepted', 'awaiting_reply', 'arbitrating', 'resolved', 'rejected', 'unresolved', 'exposed');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('none', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."identifier_type" AS ENUM('domain', 'mirror', 'app', 'tg', 'wallet', 'phone');--> statement-breakpoint
CREATE TYPE "public"."ownership" AS ENUM('official', 'fake', 'pending');--> statement-breakpoint
CREATE TYPE "public"."verification_level" AS ENUM('self_reported', 'postback_confirmed', 'operator_confirmed');--> statement-breakpoint
CREATE TYPE "public"."attribute_source" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."candidate_status" AS ENUM('pending_review', 'promoted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."confirmed_by" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('brand', 'identifier');--> statement-breakpoint
CREATE TYPE "public"."link_type" AS ENUM('shared_wallet', 'same_template', 'impersonates', 'same_operator', 'shared_support');--> statement-breakpoint
CREATE TYPE "public"."evidence_type" AS ENUM('screenshot', 'chat_log', 'tx_hash', 'other');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_kind" AS ENUM('user', 'official');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_outcome" AS ENUM('paid', 'refused', 'pending');--> statement-breakpoint
CREATE TYPE "public"."affiliate_complaint_status" AS ENUM('open', 'resolved', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."commission_model" AS ENUM('cpa', 'revshare', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('pending', 'approved', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."conversion_event" AS ENUM('register', 'first_deposit', 'deposit');--> statement-breakpoint
CREATE TYPE "public"."partner_kind" AS ENUM('kol', 'agent');--> statement-breakpoint
CREATE TYPE "public"."binding_source" AS ENUM('promo_link', 'manual');--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('telegram', 'email');--> statement-breakpoint
CREATE TYPE "public"."notify_channel" AS ENUM('telegram', 'email');--> statement-breakpoint
CREATE TYPE "public"."subscription_target" AS ENUM('brand', 'complaint', 'candidate');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('submitted', 'risk_review', 'approved', 'rejected', 'paid');--> statement-breakpoint
CREATE TYPE "public"."deposit_account" AS ENUM('user_reserve', 'excess');--> statement-breakpoint
CREATE TYPE "public"."content_locale" AS ENUM('zh-Hans', 'zh-Hant', 'en');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('guide', 'lab', 'news', 'advice');--> statement-breakpoint
CREATE TYPE "public"."abuse_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."official_channel_type" AS ENUM('domain', 'telegram', 'bot');--> statement-breakpoint
CREATE TYPE "public"."role_key" AS ENUM('arbitrator', 'commerce', 'editor', 'admin');--> statement-breakpoint
CREATE TABLE "brand_attribute" (
	"brandId" text NOT NULL,
	"dimension" text NOT NULL,
	"values" text[] NOT NULL,
	"source" "attribute_source" NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_attribute_brandId_dimension_pk" PRIMARY KEY("brandId","dimension")
);
--> statement-breakpoint
CREATE TABLE "brand" (
	"id" text PRIMARY KEY NOT NULL,
	"operatorId" text NOT NULL,
	"slug" text NOT NULL,
	"name" jsonb NOT NULL,
	"status" "brand_status" NOT NULL,
	"statusSince" date NOT NULL,
	"certifiedDepositUsdt" numeric(18, 2),
	"logoUrl" text,
	"markets" text[] DEFAULT '{}'::text[] NOT NULL,
	"hasActiveExposure" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"identifierType" "identifier_type" NOT NULL,
	"value" text NOT NULL,
	"queryCount7d" integer DEFAULT 0 NOT NULL,
	"weightedPriority" numeric(5, 4) DEFAULT 0 NOT NULL,
	"firstQueried" date NOT NULL,
	"riskSignals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "candidate_status" DEFAULT 'pending_review' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_link" (
	"id" text PRIMARY KEY NOT NULL,
	"fromKind" "entity_kind" NOT NULL,
	"fromId" text NOT NULL,
	"toKind" "entity_kind" NOT NULL,
	"toId" text NOT NULL,
	"linkType" "link_type" NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"evidence" text,
	"confirmedBy" "confirmed_by" NOT NULL,
	"confirmedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_link_confidence_range" CHECK ("entity_link"."confidence" >= 0 and "entity_link"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "identifier" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text,
	"type" "identifier_type" NOT NULL,
	"value" text NOT NULL,
	"ownership" "ownership" NOT NULL,
	"chain" text,
	"firstSeen" date,
	"lastChecked" date,
	"online" boolean,
	"note" text,
	"primary" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identifier_primary_is_official_domain" CHECK (not "identifier"."primary" or ("identifier"."type" = 'domain' and "identifier"."ownership" = 'official' and "identifier"."brandId" is not null))
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"regulator" text NOT NULL,
	"licenseNo" text NOT NULL,
	"verifiedAt" date,
	"verifiedAgainst" text,
	"valid" boolean NOT NULL,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator" (
	"id" text PRIMARY KEY NOT NULL,
	"legalName" text,
	"jurisdiction" text,
	"foundedYear" integer,
	"relatedParty" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"userId" text NOT NULL,
	"bindingId" text,
	"category" "complaint_category" NOT NULL,
	"title" text NOT NULL,
	"amountUsdt" numeric(18, 2) NOT NULL,
	"eventDate" date NOT NULL,
	"description" text NOT NULL,
	"status" "complaint_status" DEFAULT 'screening' NOT NULL,
	"publicSummary" boolean DEFAULT false NOT NULL,
	"acceptedAt" timestamp with time zone,
	"operatorNotifiedAt" timestamp with time zone,
	"secondNoticeAt" timestamp with time zone,
	"replyDeadline" timestamp with time zone,
	"operatorRepliedAt" timestamp with time zone,
	"resolvedAt" timestamp with time zone,
	"exposedAt" timestamp with time zone,
	"resolution" text,
	"relatedComplaintCount" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "complaint_amount_nonneg" CHECK ("complaint"."amountUsdt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"complaintId" text NOT NULL,
	"type" "evidence_type" NOT NULL,
	"label" text,
	"sha256" text NOT NULL,
	"txHash" text,
	"uploadedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"storageKey" text,
	"redacted" boolean DEFAULT false NOT NULL,
	"redactedAt" timestamp with time zone,
	"deletedAt" timestamp with time zone,
	CONSTRAINT "evidence_sha256_hex" CHECK ("evidence"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "exposure_complaint" (
	"exposureId" text NOT NULL,
	"complaintId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exposure_complaint_exposureId_complaintId_pk" PRIMARY KEY("exposureId","complaintId")
);
--> statement-breakpoint
CREATE TABLE "exposure" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"publishedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"totalClaimedUsdt" numeric(18, 2) DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exposure_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "operator_reply" (
	"id" text PRIMARY KEY NOT NULL,
	"complaintId" text NOT NULL,
	"repliedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text NOT NULL,
	"attachments" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"algorithmVersion" text NOT NULL,
	"computedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"score" integer,
	"confidence" "confidence_level" NOT NULL,
	"factorsAvailable" integer NOT NULL,
	"factorsTotal" integer NOT NULL,
	"factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "score_snapshot_score_range" CHECK ("score_snapshot"."score" is null or ("score_snapshot"."score" between 0 and 100)),
	CONSTRAINT "score_snapshot_factors_range" CHECK ("score_snapshot"."factorsAvailable" between 0 and "score_snapshot"."factorsTotal")
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brandId" text,
	"complaintId" text,
	"from" text,
	"to" text NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_history_one_subject" CHECK (num_nonnulls("status_history"."brandId", "status_history"."complaintId") = 1),
	CONSTRAINT "status_history_status_domain" CHECK ("status_history"."to" in ('certified', 'watch', 'blacklist', 'screening', 'accepted', 'awaiting_reply', 'arbitrating', 'resolved', 'rejected', 'unresolved', 'exposed') and ("status_history"."from" is null or "status_history"."from" in ('certified', 'watch', 'blacklist', 'screening', 'accepted', 'awaiting_reply', 'arbitrating', 'resolved', 'rejected', 'unresolved', 'exposed')))
);
--> statement-breakpoint
CREATE TABLE "withdrawal_report" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"kind" "withdrawal_kind" NOT NULL,
	"amountUsdt" numeric(18, 2) NOT NULL,
	"method" text NOT NULL,
	"requestedAt" timestamp with time zone NOT NULL,
	"receivedAt" timestamp with time zone,
	"outcome" "withdrawal_outcome" NOT NULL,
	"bindingId" text,
	"complaintId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_complaint" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amountUsdt" numeric(18, 2),
	"status" "affiliate_complaint_status" DEFAULT 'open' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "click" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"offerId" text,
	"promoCodeId" text,
	"userId" text,
	"partnerId" text,
	"slot" text,
	"channel" text,
	"region" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission" (
	"id" text PRIMARY KEY NOT NULL,
	"conversionId" text,
	"brandId" text NOT NULL,
	"partnerId" text,
	"model" "commission_model" NOT NULL,
	"amountUsdt" numeric(18, 2) NOT NULL,
	"status" "commission_status" DEFAULT 'pending' NOT NULL,
	"period" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_amount_nonneg" CHECK ("commission"."amountUsdt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversion" (
	"id" text PRIMARY KEY NOT NULL,
	"clickId" text,
	"brandId" text NOT NULL,
	"operatorAccountId" text NOT NULL,
	"event" "conversion_event" NOT NULL,
	"amountUsdt" numeric(18, 2),
	"occurredAt" timestamp with time zone,
	"receivedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "offer" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"matchPercent" integer,
	"maxBonusUsdt" numeric(18, 2),
	"minDepositUsdt" numeric(18, 2),
	"terms" jsonb NOT NULL,
	"trueValue" jsonb NOT NULL,
	"exclusive" boolean DEFAULT false NOT NULL,
	"sponsored" boolean DEFAULT false NOT NULL,
	"riskLabel" text,
	"compensationEligible" boolean DEFAULT false NOT NULL,
	"validUntil" date,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "partner_kind" NOT NULL,
	"name" text NOT NULL,
	"shareRate" numeric(5, 4),
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_code" (
	"id" text PRIMARY KEY NOT NULL,
	"offerId" text NOT NULL,
	"code" text,
	"channel" text NOT NULL,
	"claimedCount" integer DEFAULT 0 NOT NULL,
	"activeUntil" date,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text,
	"fingerprint" text NOT NULL,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"providerAccountId" text,
	"handle" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"sentAt" timestamp with time zone DEFAULT now() NOT NULL,
	"read" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "points_rule" (
	"event" text PRIMARY KEY NOT NULL,
	"points" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"userId" text NOT NULL,
	"rating" smallint NOT NULL,
	"text" text,
	"trustWeight" numeric(3, 2) DEFAULT 0 NOT NULL,
	"verifiedBinding" boolean DEFAULT false NOT NULL,
	"helpful" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_rating_range" CHECK ("review"."rating" between 1 and 5),
	CONSTRAINT "review_trust_weight_range" CHECK ("review"."trustWeight" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"targetType" "subscription_target" NOT NULL,
	"targetId" text NOT NULL,
	"channel" "notify_channel" DEFAULT 'telegram' NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_brand_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"brandId" text NOT NULL,
	"operatorAccountId" text NOT NULL,
	"operatorAccountIdHash" text NOT NULL,
	"source" "binding_source" NOT NULL,
	"promoCodeId" text,
	"boundAt" timestamp with time zone DEFAULT now() NOT NULL,
	"verificationLevel" "verification_level" DEFAULT 'self_reported' NOT NULL,
	"postbackAt" timestamp with time zone,
	"compensationEligible" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "binding_account_hash_hex" CHECK ("user_brand_binding"."operatorAccountIdHash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "binding_eligibility_level" CHECK (not "user_brand_binding"."compensationEligible" or "user_brand_binding"."verificationLevel" in ('postback_confirmed', 'operator_confirmed'))
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"displayName" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"joinedAt" date DEFAULT now() NOT NULL,
	"region" text,
	"locale" text DEFAULT 'zh-Hans' NOT NULL,
	"selfExcludedUntil" date,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim" (
	"id" text PRIMARY KEY NOT NULL,
	"complaintId" text NOT NULL,
	"bindingId" text NOT NULL,
	"amountUsdt" numeric(18, 2) NOT NULL,
	"status" "claim_status" DEFAULT 'submitted' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_amount_nonneg" CHECK ("claim"."amountUsdt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deposit" (
	"id" text PRIMARY KEY NOT NULL,
	"brandId" text NOT NULL,
	"account" "deposit_account" NOT NULL,
	"amountUsdt" numeric(18, 2) NOT NULL,
	"chain" text,
	"txHash" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout" (
	"id" text PRIMARY KEY NOT NULL,
	"claimId" text NOT NULL,
	"amountUsdt" numeric(18, 2) NOT NULL,
	"chain" text,
	"txHash" text,
	"paidAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "content_type" NOT NULL,
	"key" text,
	"slug" text,
	"locale" "content_locale" DEFAULT 'zh-Hans' NOT NULL,
	"sourceId" text,
	"title" text NOT NULL,
	"body" text,
	"publishedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary" (
	"id" text PRIMARY KEY NOT NULL,
	"zhHans" text NOT NULL,
	"zhHant" text,
	"zhHantHkSynonyms" text[],
	"en" text,
	"note" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glossary_zhHans_unique" UNIQUE("zhHans")
);
--> statement-breakpoint
CREATE TABLE "sim_result" (
	"id" text PRIMARY KEY NOT NULL,
	"strategy" text NOT NULL,
	"params" jsonb,
	"runs" integer NOT NULL,
	"bustProbability" numeric(5, 4) NOT NULL,
	"expectedValue" numeric(18, 4) NOT NULL,
	"computedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abuse_flag" (
	"id" text PRIMARY KEY NOT NULL,
	"subjectType" text NOT NULL,
	"subjectId" text NOT NULL,
	"reason" text NOT NULL,
	"severity" "abuse_severity" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actorId" text NOT NULL,
	"actorRole" "role_key",
	"action" text NOT NULL,
	"targetType" text NOT NULL,
	"targetId" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "official_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "official_channel_type" NOT NULL,
	"value" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"verifiedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"windowSeconds" integer NOT NULL,
	"maxRequests" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"key" "role_key" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"userId" text NOT NULL,
	"roleKey" "role_key" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_userId_roleKey_pk" PRIMARY KEY("userId","roleKey")
);
--> statement-breakpoint
ALTER TABLE "brand_attribute" ADD CONSTRAINT "brand_attribute_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand" ADD CONSTRAINT "brand_operatorId_operator_id_fk" FOREIGN KEY ("operatorId") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifier" ADD CONSTRAINT "identifier_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_bindingId_user_brand_binding_id_fk" FOREIGN KEY ("bindingId") REFERENCES "public"."user_brand_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_complaintId_complaint_id_fk" FOREIGN KEY ("complaintId") REFERENCES "public"."complaint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_complaint" ADD CONSTRAINT "exposure_complaint_exposureId_exposure_id_fk" FOREIGN KEY ("exposureId") REFERENCES "public"."exposure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure_complaint" ADD CONSTRAINT "exposure_complaint_complaintId_complaint_id_fk" FOREIGN KEY ("complaintId") REFERENCES "public"."complaint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exposure" ADD CONSTRAINT "exposure_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_reply" ADD CONSTRAINT "operator_reply_complaintId_complaint_id_fk" FOREIGN KEY ("complaintId") REFERENCES "public"."complaint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_snapshot" ADD CONSTRAINT "score_snapshot_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_complaintId_complaint_id_fk" FOREIGN KEY ("complaintId") REFERENCES "public"."complaint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD CONSTRAINT "withdrawal_report_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD CONSTRAINT "withdrawal_report_bindingId_user_brand_binding_id_fk" FOREIGN KEY ("bindingId") REFERENCES "public"."user_brand_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_report" ADD CONSTRAINT "withdrawal_report_complaintId_complaint_id_fk" FOREIGN KEY ("complaintId") REFERENCES "public"."complaint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_complaint" ADD CONSTRAINT "affiliate_complaint_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click" ADD CONSTRAINT "click_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click" ADD CONSTRAINT "click_offerId_offer_id_fk" FOREIGN KEY ("offerId") REFERENCES "public"."offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click" ADD CONSTRAINT "click_promoCodeId_promo_code_id_fk" FOREIGN KEY ("promoCodeId") REFERENCES "public"."promo_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click" ADD CONSTRAINT "click_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click" ADD CONSTRAINT "click_partnerId_partner_id_fk" FOREIGN KEY ("partnerId") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission" ADD CONSTRAINT "commission_conversionId_conversion_id_fk" FOREIGN KEY ("conversionId") REFERENCES "public"."conversion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission" ADD CONSTRAINT "commission_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission" ADD CONSTRAINT "commission_partnerId_partner_id_fk" FOREIGN KEY ("partnerId") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_clickId_click_id_fk" FOREIGN KEY ("clickId") REFERENCES "public"."click"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_offerId_offer_id_fk" FOREIGN KEY ("offerId") REFERENCES "public"."offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity" ADD CONSTRAINT "identity_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD CONSTRAINT "user_brand_binding_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD CONSTRAINT "user_brand_binding_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_binding" ADD CONSTRAINT "user_brand_binding_promoCodeId_promo_code_id_fk" FOREIGN KEY ("promoCodeId") REFERENCES "public"."promo_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_complaintId_complaint_id_fk" FOREIGN KEY ("complaintId") REFERENCES "public"."complaint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_bindingId_user_brand_binding_id_fk" FOREIGN KEY ("bindingId") REFERENCES "public"."user_brand_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit" ADD CONSTRAINT "deposit_brandId_brand_id_fk" FOREIGN KEY ("brandId") REFERENCES "public"."brand"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_claimId_claim_id_fk" FOREIGN KEY ("claimId") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_app_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_roleKey_role_key_fk" FOREIGN KEY ("roleKey") REFERENCES "public"."role"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_status_idx" ON "brand" USING btree ("status");--> statement-breakpoint
CREATE INDEX "brand_markets_gin" ON "brand" USING gin ("markets");--> statement-breakpoint
CREATE INDEX "candidate_type_value_idx" ON "candidate" USING btree ("identifierType","value");--> statement-breakpoint
CREATE INDEX "candidate_priority_idx" ON "candidate" USING btree ("weightedPriority");--> statement-breakpoint
CREATE INDEX "entity_link_from_idx" ON "entity_link" USING btree ("fromKind","fromId");--> statement-breakpoint
CREATE INDEX "entity_link_to_idx" ON "entity_link" USING btree ("toKind","toId");--> statement-breakpoint
CREATE UNIQUE INDEX "identifier_primary_per_brand_uq" ON "identifier" USING btree ("brandId") WHERE "identifier"."primary";--> statement-breakpoint
CREATE INDEX "identifier_type_value_idx" ON "identifier" USING btree ("type","value");--> statement-breakpoint
CREATE INDEX "identifier_brand_idx" ON "identifier" USING btree ("brandId");--> statement-breakpoint
CREATE INDEX "identifier_value_trgm" ON "identifier" USING gin ("value" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "complaint_brand_idx" ON "complaint" USING btree ("brandId","status");--> statement-breakpoint
CREATE INDEX "complaint_user_idx" ON "complaint" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "evidence_complaint_idx" ON "evidence" USING btree ("complaintId");--> statement-breakpoint
CREATE INDEX "exposure_complaint_complaint_idx" ON "exposure_complaint" USING btree ("complaintId");--> statement-breakpoint
CREATE INDEX "exposure_brand_idx" ON "exposure" USING btree ("brandId");--> statement-breakpoint
CREATE INDEX "operator_reply_complaint_idx" ON "operator_reply" USING btree ("complaintId");--> statement-breakpoint
CREATE INDEX "score_snapshot_brand_idx" ON "score_snapshot" USING btree ("brandId","computedAt");--> statement-breakpoint
CREATE INDEX "status_history_brand_idx" ON "status_history" USING btree ("brandId","at");--> statement-breakpoint
CREATE INDEX "status_history_complaint_idx" ON "status_history" USING btree ("complaintId","at");--> statement-breakpoint
CREATE INDEX "withdrawal_report_brand_idx" ON "withdrawal_report" USING btree ("brandId","kind");--> statement-breakpoint
CREATE INDEX "click_brand_idx" ON "click" USING btree ("brandId","createdAt");--> statement-breakpoint
CREATE INDEX "commission_brand_idx" ON "commission" USING btree ("brandId","status");--> statement-breakpoint
CREATE INDEX "conversion_brand_account_idx" ON "conversion" USING btree ("brandId","operatorAccountId");--> statement-breakpoint
CREATE INDEX "offer_brand_idx" ON "offer" USING btree ("brandId");--> statement-breakpoint
CREATE INDEX "promo_code_offer_idx" ON "promo_code" USING btree ("offerId");--> statement-breakpoint
CREATE INDEX "device_fingerprint_idx" ON "device" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "device_user_idx" ON "device" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "identity_user_idx" ON "identity" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_provider_account_uq" ON "identity" USING btree ("provider","providerAccountId");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("userId","sentAt");--> statement-breakpoint
CREATE INDEX "review_brand_idx" ON "review" USING btree ("brandId");--> statement-breakpoint
CREATE INDEX "subscription_target_idx" ON "subscription" USING btree ("targetType","targetId");--> statement-breakpoint
CREATE INDEX "subscription_user_idx" ON "subscription" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "binding_brand_account_hash_uq" ON "user_brand_binding" USING btree ("brandId","operatorAccountIdHash");--> statement-breakpoint
CREATE INDEX "binding_user_idx" ON "user_brand_binding" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "binding_brand_idx" ON "user_brand_binding" USING btree ("brandId");--> statement-breakpoint
CREATE INDEX "deposit_brand_idx" ON "deposit" USING btree ("brandId","account");--> statement-breakpoint
CREATE UNIQUE INDEX "content_type_slug_locale_uq" ON "content" USING btree ("type","slug","locale");--> statement-breakpoint
CREATE INDEX "content_type_key_idx" ON "content" USING btree ("type","key","locale");--> statement-breakpoint
CREATE INDEX "abuse_flag_subject_idx" ON "abuse_flag" USING btree ("subjectType","subjectId");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("targetType","targetId");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actorId","at");--> statement-breakpoint
CREATE UNIQUE INDEX "official_channel_type_value_uq" ON "official_channel" USING btree ("type","value");