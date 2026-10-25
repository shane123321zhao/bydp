/**
 * W2#011 裁定 1：UAT 收尾清理（**仅测试站**）。把 UAT 测试账号仍待审的出款凭证 / 评价驳回，避免后台「提交审核」列表随每轮 UAT 累积；
 * W3#090 起同口径驳回其待处理的数据请求（后台「数据请求」列表同样累积）。
 * 用法（测试站 worker 容器内）：tsx src/cli/uat-cleanup.ts --run <运行编号>   # 本轮（scripts/uat.sh 结束时自动调用）
 *                               tsx src/cli/uat-cleanup.ts --all             # 一次性：历次所有 +uat 测试账号
 * - 测试账号识别：邮箱身份解密后匹配 PO #26 专用测试邮箱的「+uat」别名（与 uat-user.ts 同一口径）；其他账号一律不碰。
 * - 走正常判定路径 core decideSubmission（驳回原因「UAT 自动清理」，写 audit_log、通知提交人）；执行身份为系统身份 system:uat-cleanup，
 *   不是被清理的测试账号本人（自审禁令）。只输出计数，不打印邮箱。
 */
import { connect } from '@bydp/core/runtime';
import { rejectPendingSubmissionsOf } from '@bydp/core/admin/submissions';
import { rejectPendingDataRequestsOf } from '@bydp/core/admin/data-requests';
import type { EvidenceStore } from '@bydp/core/complaint/write';
import { findEmailUsers } from '@bydp/core/identity/auth';
import { identityKeysFromEnv } from '@bydp/core/identity/pii';

if (process.env.BYDP_ENV !== 'staging') {
  console.error('拒绝执行：仅测试站可用');
  process.exit(1);
}
const args = process.argv.slice(2);
const all = args.includes('--all');
const run = args[args.indexOf('--run') + 1] ?? '';
if (!all && !(args.includes('--run') && /^[0-9]{10}$/.test(run))) {
  console.error('用法：uat-cleanup.ts --run <10 位运行编号> | --all');
  process.exit(2);
}
// W2#013：本地部分锁定为 PO #26 测试邮箱（服务器 .env.prod 的 UAT_MAILBOX_LOCALPART，非密钥）；未设置一律拒绝（失败即关）
const LOCAL = (process.env.UAT_MAILBOX_LOCALPART ?? '').trim().toLowerCase();
if (!/^[a-z0-9.]{1,64}$/.test(LOCAL)) {
  console.error('拒绝执行：UAT_MAILBOX_LOCALPART 未设置');
  process.exit(1);
}
const LOCAL_RE = LOCAL.replaceAll('.', '\\.');
const UAT = new RegExp(all ? `^${LOCAL_RE}\\+uat[a-z0-9]{1,24}@gmail\\.com$` : `^${LOCAL_RE}\\+uat${run}[dp][a-z]@gmail\\.com$`);

const { db, client } = connect();
let code = 0;
try {
  const users = await findEmailUsers(db, identityKeysFromEnv(), (e) => UAT.test(e));
  const actor = { id: 'system:uat-cleanup', role: 'admin' as const, ip: null };
  const done = await rejectPendingSubmissionsOf(db, users, actor, 'UAT 自动清理');
  // W3#090：数据请求同样累积（后台每页 50 条、按先后），挤掉本轮请求 → 一并驳回；驳回路径不碰证据对象，store 只为签名需要，误用即报错
  const noStore: EvidenceStore = { put: () => Promise.reject(new Error('清理不应写对象')), get: () => Promise.reject(new Error('清理不应读对象')), delete: () => Promise.reject(new Error('清理不应删对象')), exists: () => Promise.reject(new Error('清理不应查对象')) };
  const dr = await rejectPendingDataRequestsOf(db, noStore, users, actor, 'UAT 自动清理');
  const failed = done.failed + dr.failed;
  console.log(`UAT 清理（${all ? '全部 +uat 账号' : `运行 ${run}`}）：测试账号 ${users.length} 个 · 驳回凭证 ${done.withdrawal} · 驳回评价 ${done.review} · 驳回数据请求 ${dr.rejected}${failed ? ` · 失败 ${failed}` : ''}`);
  if (failed) code = 1;
} finally {
  await client.end();
}
process.exit(code);
