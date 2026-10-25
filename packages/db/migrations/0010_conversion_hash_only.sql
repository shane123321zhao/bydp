-- A-013（#17）：conversion 只存盲索引。回传原文 raw 不得再含账号字段，由 CHECK 约束新写入。
-- conversion 为只追加表，迁移同样不得改写（§9.2 v1.9）：存量不剔除，CHECK 以 NOT VALID 添加，只对新写入生效；
-- 生产库全新初始化（上线前置 #9），存量仅测试站测试数据。
ALTER TABLE "conversion" DROP COLUMN "operatorAccountId";--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_raw_no_account" CHECK ("conversion"."raw" is null or not ("conversion"."raw" ? 'operatorAccountId')) NOT VALID;
