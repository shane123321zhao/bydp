/**
 * D-027 品牌资料导入（`pnpm db:import:brands <文件.xlsx> --requested-by <管理员 userId | dev:D-xxx> [--dry-run]`；服务器上：
 * `docker compose exec -T worker ./node_modules/.bin/tsx src/cli/import-brands.ts …`，文件经 stdin 传入时用 `-` 代替路径）。
 * - 先 --dry-run：同一写入路径在事务内执行后回滚，逐行中文报错 / 列出将新增与更新的数量；无问题再去掉 --dry-run 正式导入（单事务）。
 * - W2#012：执行身份固定为系统身份 system:brand-import（不冒用真人账号）；--requested-by 记「谁要求导入」：真实导入填 PO 的 userId（须为管理员），
 *   模拟导入填 dev:D-xxx（仅测试站）。正式环境拒绝含「示例」名称或 .invalid 标识的文件（模拟数据只进测试站）。
 * - 提交后同步搜索索引（Meili 已配置时；未配置时每日全量重建兜底）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { connect } from '@bydp/core/runtime';
import { applyImport, BrandImportError, type ImportSummary } from '@bydp/core/admin/brand-import';
import { getUserRoles } from '@bydp/core/admin/rbac';
import { meiliFromEnv } from '@bydp/core/search/meili';
import { syncSearchDocs } from '@bydp/core/search/indexer';
import { readWorkbook } from './brand-xlsx';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const reqAt = args.indexOf('--requested-by');
const requestedBy = reqAt >= 0 ? (args[reqAt + 1] ?? '') : '';
const path = args.find((a, i) => !a.startsWith('--') && i !== reqAt + 1);
const devReq = /^dev:D-\d{3}$/.test(requestedBy);
if (!path || !(/^u_[A-Za-z0-9_]+$/.test(requestedBy) || devReq)) {
  console.error('用法：import-brands <文件.xlsx | -> --requested-by <管理员 userId | dev:D-xxx> [--dry-run]');
  process.exit(2);
}
// pnpm --filter 在 worker 目录执行：相对路径按调用命令时所在目录（INIT_CWD）解析
const buf = path === '-' ? readFileSync(0) : readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), path));
if (buf.byteLength > 10 * 1024 * 1024) {
  console.error('❌ 文件超过 10MB');
  process.exit(2);
}
const file = { name: path === '-' ? 'stdin.xlsx' : basename(path), sha256: createHash('sha256').update(buf).digest('hex'), requestedBy };

const { input, problems } = await readWorkbook(buf);
if (process.env.BYDP_ENV === 'production') {
  for (const r of input.brands) if (/示例/.test(`${r.v.zhHans ?? ''}${r.v.zhHant ?? ''}${r.v.en ?? ''}`)) problems.push(`「品牌」第 ${r.row} 行：正式环境不接受名称带「示例」的模拟品牌`);
  for (const r of input.identifiers) if (/\.invalid$/i.test(r.v.value ?? '')) problems.push(`「标识」第 ${r.row} 行：正式环境不接受 .invalid 模拟域名`);
}
if (problems.length) {
  for (const p of problems) console.log(`❌ ${p}`);
  console.log(`—— 共 ${problems.length} 处问题，未写入`);
  process.exit(1);
}

const SHEETS: [keyof ImportSummary['created'], string][] = [['operators', '运营商'], ['brands', '品牌'], ['identifiers', '标识'], ['licenses', '牌照'], ['attributes', '属性'], ['offers', '优惠']];
const DRY = Symbol('dry-run');
const { db, client } = connect();
let code = 0;
try {
  if (devReq && process.env.BYDP_ENV !== 'staging') throw new Error('dev:D-xxx 只用于测试站的模拟导入；正式导入请填要求导入的管理员 userId');
  if (!devReq && !(await getUserRoles(db, requestedBy)).includes('admin')) throw new Error('--requested-by 须为管理员账号');
  let sum: ImportSummary | undefined;
  await db
    .transaction(async (tx) => {
      sum = await applyImport(tx, input, { id: 'system:brand-import', role: 'admin', ip: null }, file);
      if (dry) throw DRY;
    })
    .catch((e) => {
      if (e !== DRY) throw e;
    });
  const s = sum!;
  console.log(`${dry ? '🔍 预检通过（未写入）' : '✅ 导入完成'} ｜ 文件 ${file.name} · sha256 ${file.sha256.slice(0, 12)}`);
  for (const [k, name] of SHEETS) console.log(`   ${name}：新增 ${s.created[k]} · 更新 ${s.updated[k]}`);
  for (const n of s.notes) console.log(`⚠️ ${n}`);
  if (!dry) {
    const meili = meiliFromEnv(process.env, 'write');
    if (meili && s.brandIds.length) {
      const r = await syncSearchDocs(db, meili, { kind: 'brand', ids: s.brandIds }).catch((e: Error) => ({ error: e.message.slice(0, 80) }));
      console.log(`   搜索索引：${'error' in r ? `同步失败（${r.error}），每日全量重建会补上` : `已同步 ${r.upserted} 个品牌`}`);
    }
  }
} catch (e) {
  if (e instanceof BrandImportError) {
    for (const p of e.problems) console.log(`❌ ${p}`);
    console.log(`—— 共 ${e.problems.length} 处问题，未写入`);
  } else console.log(`❌ ${(e as Error).message.slice(0, 300)}`);
  code = 1;
} finally {
  await client.end();
}
process.exit(code);
