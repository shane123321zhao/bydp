import { defineConfig } from 'drizzle-kit';

// 迁移输出到 migrations/：新增迁移属双签（mailbox/.approvals/db），已应用迁移禁改（ADR-0006）。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://bydp:pass@localhost:5432/bydp' },
  strict: true,
  verbose: true,
});
