/**
 * W2#012：UAT 测试会话（**仅测试站**）——为 `+uat` 测试账号直接签发会话，替代逐个收登录信（Resend 免费档每日 100 封；每轮 UAT 只保留 1 条真实邮箱登录）。
 * 用法（测试站 api 容器内）：tsx src/cli/uat-session.ts <+uat 测试邮箱>；输出一行 JSON {userId, token}，只交回调用它的测试进程（e2e/uat/session.ts），不打印到日志。
 * - 只接受 PO #26 专用测试邮箱（本地部分 = UAT_MAILBOX_LOCALPART）的「+uat」别名（与 worker uat-user.ts 同一口径）；BYDP_ENV ≠ staging 一律拒绝。
 * - 账号与身份走真实登录同一路径（signInWithIdentity：不存在则建号；自我排除拦截的身份照样拒绝）；令牌与 Auth.js 会话同格式
 *   （@auth/core encode，salt = __Secure-authjs.session-token，载荷 uid / epoch / authTime），会话校验仍由站点按 sessionEpoch 与 30 天上限进行。
 * - 不改登录代码；只是测试站专用工具。
 */
import { encode } from '@auth/core/jwt';
import { connect } from '@bydp/core/runtime';
import { signInWithIdentity, userSessionEpoch } from '@bydp/core/identity/auth';
import { identityKeysFromEnv, maskEmail } from '@bydp/core/identity/pii';
import { SESSION_MAX_AGE_SEC } from '@bydp/core/identity/authjs';

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
const secret = process.env.AUTH_SECRET;
if (!secret) {
  console.error('AUTH_SECRET 未设置');
  process.exit(1);
}
const { db, client } = connect();
let code = 0;
try {
  const { userId } = await signInWithIdentity(db, { provider: 'email', account: email, handle: maskEmail(email) }, identityKeysFromEnv());
  const epoch = await userSessionEpoch(db, userId);
  if (epoch == null) throw new Error('账号不可用');
  const token = await encode({ token: { sub: userId, uid: userId, epoch, authTime: Math.floor(Date.now() / 1000) }, secret, salt: '__Secure-authjs.session-token', maxAge: SESSION_MAX_AGE_SEC });
  process.stdout.write(JSON.stringify({ userId, token }) + '\n');
} catch (e) {
  console.error(`签发失败：${(e as Error).name}`);
  code = 1;
} finally {
  await client.end();
}
process.exit(code);
