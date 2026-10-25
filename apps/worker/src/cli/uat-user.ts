/**
 * D-022 UAT：按测试邮箱查 userId（**仅测试站**），供 scripts/uat.sh 给本次运行的测试账号授予 / 收回后台角色（grant-role 需要 userId）。
 * 用法：docker compose exec -T worker ./node_modules/.bin/tsx src/cli/uat-user.ts <邮箱>
 * 只接受 PO #26 专用测试邮箱的「+uat」别名（`<UAT_IMAP_USER 本地名>+uat…@gmail.com`），其他邮箱一律拒绝；正式环境拒绝。
 * 输出一行 userId（不是密钥）；查不到退出码 1。
 */
import { connect } from '@bydp/core/runtime';
import { findUserByEmail } from '@bydp/core/identity/auth';
import { identityKeysFromEnv } from '@bydp/core/identity/pii';

if (process.env.BYDP_ENV !== 'staging') {
  console.error('拒绝执行：仅测试站可用');
  process.exit(1);
}
// W2#013：本地部分锁定为 PO #26 测试邮箱（服务器 .env.prod 的 UAT_MAILBOX_LOCALPART，非密钥）；未设置一律拒绝（失败即关）
const LOCAL = (process.env.UAT_MAILBOX_LOCALPART ?? '').trim().toLowerCase();
if (!/^[a-z0-9.]{1,64}$/.test(LOCAL)) {
  console.error('拒绝执行：UAT_MAILBOX_LOCALPART 未设置');
  process.exit(1);
}
const LOCAL_RE = LOCAL.replaceAll('.', '\\.');
const email = (process.argv[2] ?? '').toLowerCase();
if (!new RegExp(`^${LOCAL_RE}\\+uat[a-z0-9]{1,24}@gmail\\.com$`).test(email)) {
  console.error('只接受 UAT 测试邮箱别名（xxx+uat…@gmail.com）');
  process.exit(2);
}
const { db, client } = connect();
try {
  const id = await findUserByEmail(db, email, identityKeysFromEnv());
  if (!id) {
    console.error('未找到该测试账号');
    process.exit(1);
  }
  console.log(id);
} finally {
  await client.end();
}
process.exit(0);
