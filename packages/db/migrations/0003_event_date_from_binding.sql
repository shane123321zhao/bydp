ALTER TABLE "withdrawal_report" ADD COLUMN "fromBinding" boolean GENERATED ALWAYS AS ("bindingId" IS NOT NULL) STORED;--> statement-breakpoint
ALTER TABLE "complaint" ADD CONSTRAINT "complaint_event_date_not_future" CHECK ("complaint"."eventDate" <= ("complaint"."createdAt" AT TIME ZONE 'Etc/GMT-14')::date);--> statement-breakpoint
-- A-002：scoring_ro 可读 fromBinding（bindingId 本身仍不授权）
GRANT SELECT ("fromBinding") ON "withdrawal_report" TO bydp_scoring_ro;
