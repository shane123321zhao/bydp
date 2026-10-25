/**
 * D-034：后台账号密码登录入口（/admin/login）。只在测试站开关打开时显示表单；真正的校验在主站 Auth.js Credentials「admin-password」
 * （core identity/password-login：单账号白名单、scrypt、限流与锁定、正式环境不启用）。未开启时引导到主站登录。
 */
import { PasswordLoginForm } from './PasswordLoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const enabled = process.env.ADMIN_PASSWORD_LOGIN === 'on' && process.env.BYDP_ENV !== 'production';
  return (
    <section className="panel" style={{ maxWidth: 420, margin: '10vh auto 0' }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>BYDP 运营后台 · 登录</h1>
      {enabled ? (
        <PasswordLoginForm />
      ) : (
        <p className="hint">
          账号密码登录未开启。请 <a className="link" href="/login?callbackUrl=%2Fadmin">前往主站登录</a>（Telegram 或邮箱）。
        </p>
      )}
    </section>
  );
}
