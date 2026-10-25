# Cloudflare 接入 · 后台独立子域 + Access（正式环境）

> 对应 HANDOVER §9 #2 / #3 / #4 / #22 · D-020。**测试站不按本文改**（测试站维持 Cookie 门禁 + `/admin` 路径；W2#010 起门禁取代 Basic Auth）。
> 本文是点击级步骤：PO 只需在浏览器里点；带「开发」标记的步骤由开发会话在服务器上执行。全程不需要把任何密钥贴进对话。
> 以下以主站 `northx.vip`、后台 `admin.northx.vip` 为例，实际域名以 PO 决定为准（生产落位 #28 / PO #15）。

## 0. 结果是什么样
- 访客访问 `northx.vip` → 经 Cloudflare（隐藏源站 IP、大陆屏蔽、抗攻击）→ 源站。
- 后台只在 `admin.northx.vip`：先过 Cloudflare Access（只放行 PO 指定邮箱，邮箱收一次性验证码），再到 BYDP 后台登录。
- 源站服务器的 80 / 443 只接受 Cloudflare 的回源连接，直连 IP 访问不通。

## 1. 把域名接入 Cloudflare（PO，约 10 分钟 + 等待生效）
1. 打开 https://dash.cloudflare.com → 注册 / 登录（建议用 PO 本人邮箱，开两步验证：右上头像 → My Profile → Authentication → Two-Factor Authentication）。
2. 首页点 **Add a domain** → 输入 `northx.vip` → **Continue** → 选 **Free** 计划 → **Continue**。
3. Cloudflare 会自动扫描现有 DNS 记录，点 **Continue to activation**。
4. 页面会给出两个 Cloudflare 名称服务器（形如 `xxx.ns.cloudflare.com`），**先别关这个页面**。
5. 新开标签页登录 GoDaddy → 我的产品 → `northx.vip` 右侧 **DNS** → 顶部 **名称服务器（Nameservers）** → **更改** → 选 **我将使用自己的名称服务器** → 填入上一步两个地址 → 保存。
6. 回到 Cloudflare 页面点 **Check nameservers**。生效通常几分钟到几小时，生效后 Cloudflare 会发邮件「northx.vip is now active」。

## 2. DNS 记录（PO）
Cloudflare 左侧 **DNS → Records**。**先全部设为灰色云（DNS only）**：源站首次签发 HTTPS 证书（Let's Encrypt HTTP-01）需要直连；
开橙云 + Full (strict) + Always Use HTTPS 之后再首签，验证请求会被跳到 HTTPS 而源站还没证书（525 / 526），后台子域的验证还会被 Access 挡住。
| 类型 | 名称 | 内容 | 代理状态（首签前 → 首签后） |
|---|---|---|---|
| A | `@` | 生产服务器公网 IP | 灰色云 → **橙色云（Proxied）** |
| A | `admin` | 同上 | 灰色云 → **橙色云（Proxied）** |
| A | `staging` | <测试站服务器 IP> | 灰色云（DNS only，测试站不经 Cloudflare） |

顺序：本节建记录（灰云）→ 第 5 节开发首次部署（证书签发成功，bootstrap 第 8 步显示通过）→ 回到这里把 `@` 与 `admin` 点成**橙色云** → 再做第 3、4 节。
之后证书续期走 Cloudflare 回源（HTTP-01 仍可达源站 80，防火墙放行 Cloudflare 段），无需再切灰云。

- 已存在的同名记录点 **Edit** 改；多余的旧记录（如指向 GoDaddy 停放页的）删除。
- `mail.northx.vip` 等 Resend 发信相关的 TXT / MX / CNAME 记录**保持原样**（第 1 步自动导入了，核对还在即可）。

## 3. SSL / 安全设置（PO）
1. 左侧 **SSL/TLS → Overview** → 加密模式选 **Full (strict)**。
2. **SSL/TLS → Edge Certificates** → 打开 **Always Use HTTPS**。
3. **Security → WAF → Custom rules** → **Create rule**：
   - Rule name：`block-mainland`
   - 点 **Edit expression**，粘贴：
     ```
     (ip.src.country eq "CN") and not (http.request.uri.path in {"/regions" "/zh-hant/regions" "/en/regions"}) and not starts_with(http.request.uri.path, "/v1/postback/")
     ```
   - Then take action：**Block** → **Deploy**。
   - 说明：边缘拦截为主，应用层 451 声明页为兜底（ADR-0007）；运营商回传（postback）不受地区限制。

## 4. Cloudflare Access 保护后台（PO，约 5 分钟）
1. 左侧 **Zero Trust**（首次进入需选一个团队名，随意，如 `bydp`；计划选 **Free**，可能要求绑卡但 50 人以内免费）。
2. **Settings → Authentication → Login methods**：确认有 **One-time PIN**（默认就有）。
3. **Access → Applications → Add an application → Self-hosted**：
   - Application name：`BYDP Admin`
   - Session Duration：`24 hours`
   - Application domain：Subdomain 填 `admin`，Domain 选 `northx.vip`，Path **留空**（覆盖整个后台子域，含 `/admin` 页面与登录）
   - **Next**
4. 策略（Policy）：
   - Policy name：`PO only`
   - Action：**Allow**
   - Configure rules → **Include** → Selector 选 **Emails** → 填 PO 邮箱（需要给其他人开后台时在这里加邮箱）
   - **Next** → **Add application**。
5. **复制两个值给开发（不是密钥，可以直接发）**：
   - 团队域名：Zero Trust 左侧 **Settings → Custom Pages**（或 **Settings → General**）页顶的 **Team domain**，形如 `bydp.cloudflareaccess.com`；
   - AUD：**Access → Applications** → 点 `BYDP Admin` → **Overview** 页的 **Application Audience (AUD) Tag**（64 位字母数字）。
   开发填入服务器 `.env.prod.input` 的 `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`：后台源站会校验每个请求带的 Access 凭证（#30），
   防止他人用自己的 Cloudflare 账号绕过本应用的 Access。未填时正式环境拒绝部署、后台一律 403。
6. 自检：浏览器无痕窗口打开 `https://admin.northx.vip/admin` → 应先看到 Cloudflare Access 页面要求输入邮箱 → 收验证码 → 通过后才看到 BYDP 后台登录页。

## 5. 服务器（开发）
1. `deploy/.env.prod.input` 增加：`BYDP_BEHIND_CLOUDFLARE=1`、`ADMIN_HOST=admin.northx.vip`；（后台要 Telegram 登录时另填 `ADMIN_TELEGRAM_BOT_TOKEN` / `ADMIN_TELEGRAM_BOT_USERNAME`，见第 6 节）。
2. `bash deploy/bootstrap.sh`：Caddy 改为只信任 Cloudflare 回源段；主站不再转发 `/admin`；启动后台登录实例 auth-admin。
3. `sudo bash deploy/firewall-cloudflare.sh --persist`：80 / 443 只放行 Cloudflare 回源，开机自动重放。
4. 自检（任意电脑）：`bash scripts/cf-ready-check.sh northx.vip <服务器IP>`；服务器上加 `--server`。每行「✅ 通过 / ❌ 失败」，全部通过才算就绪。

## 6. 后台登录方式（需 PO 决定）
- Telegram 登录组件**一个 Bot 只能绑一个域名**（当前 @BYDP_001_bot 绑的是主站）。后台子域要用 TG 登录，需另建一个后台专用 Bot：
  Telegram 打开 @BotFather → `/newbot` → 名字如 `BYDP Admin` → 用户名如 `BYDP_admin_bot` → BotFather 回复的 token **不要贴进任何会话**，用文本编辑器填入服务器 `.env.prod.input` 的 `ADMIN_TELEGRAM_BOT_TOKEN`（开发会给出文件位置）→ 再对 @BotFather 发 `/setdomain` → 选新 Bot → 填 `admin.northx.vip`。
- 不建后台 Bot 时，后台只能用**邮箱登录**：那么 admin 角色要授给 PO 的邮箱账号（当前 admin 在 PO 的 TG 账号上）。

## 6b. AOP：源站只认我们自己 zone 的回源（#31，建议，正式环境接入 Cloudflare 后做）
**为什么**：防火墙只按「来源 IP 属于 Cloudflare」放行，别人的 Cloudflare 账号也能把域名指向我们的源站 IP，绕过我们的 WAF 大陆规则（后台另有 #30 Access 凭证校验兜底）。
开启 AOP 后，Cloudflare 回源时会出示一张**只有我们 zone 才有**的客户端证书，源站不认就握手失败。

**前提与顺序（不能反，否则全站中断）**：
- SSL/TLS 模式必须已是 **Full (strict)**（第 3 节）；
- 先在 Cloudflare 侧上传证书并开启 zone 级 AOP（下面第 1、2 步），**确认完成后**再把源站开关 `CF_AOP_ENABLED` 置 1（第 3 步）。
  先开源站、Cloudflare 还没出示证书，所有回源都会握手失败。
- 客户端证书有效期 **825 天**：在签发日 + 800 天之前运行 `bash scripts/aop-zone-cert.sh --env-file ~/bydp-keys/cloudflare.env --renew` 换证
  （沿用同一 CA，服务器 `aop-ca.pem` 不用换；脚本会删掉旧证书；脚本最后一行打印的到期日记进日历）。

**第 1 步：建 API 令牌（PO，2 分钟）**
1. Cloudflare 右上头像 → **My Profile → API Tokens → Create Token → Create Custom Token**：
   - Token name：`bydp-aop`；Permissions：**Zone → SSL and Certificates → Edit**；Zone Resources：**Include → Specific zone → northx.vip** → Continue → Create。
2. 用文本编辑器新建 `~/bydp-keys/cloudflare.env`，写两行（令牌不要贴进任何会话）：
   ```
   CF_API_TOKEN=〈刚生成的令牌〉
   CF_ZONE_ID=〈域名概览页右下角的 Zone ID〉
   ```

**第 2 步：生成并上传证书（PO 本机，1 条命令）**
在项目目录运行：`bash scripts/aop-zone-cert.sh --env-file ~/bydp-keys/cloudflare.env`
- 每行显示「✅ 通过」即完成：本机生成我方证书（私钥只在 `~/bydp-keys/aop/`）、上传到本 zone、开启 AOP。
- 把 `~/bydp-keys/aop/ca.pem`（**公开的 CA 证书，不是私钥**）交给开发。
- 做完可回 Cloudflare 把 `bydp-aop` 令牌 **Roll / Delete**（之后不再需要）。

**第 3 步：服务器（开发）**
1. `ca.pem` 放到服务器 `deploy/aop-ca.pem`；`.env.prod.input` 设 `CF_AOP_ENABLED=1`。
2. `bash deploy/bootstrap.sh --prod`：开关为 1 而证书缺失或非法会直接拒绝部署（不会出现「开了却没生效」）。
3. 自检：`bash scripts/cf-ready-check.sh <域名> <源站IP> --server` 中「AOP：不带回源客户端证书的 TLS 握手被拒」显示通过。

> 只想点控制台、不跑脚本：SSL/TLS → Origin Server → 打开 **Authenticated Origin Pulls**（全局证书）也能挡住非 Cloudflare 流量，
> 但全局证书所有 Cloudflare 客户共用，**挡不住他人 Cloudflare 账号**；此时服务器 `aop-ca.pem` 用 Cloudflare 公布的全局回源 CA。推荐上面的 zone 证书。
> 测试站不开启（不经 Cloudflare）。

## 7. 已知残余风险（#30 已补后台；主站见 #31 / 6b 节）
- 源站只按「来源 IP 属于 Cloudflare」放行：**任何其他 Cloudflare 账号**都能在自己的 zone 里把记录指向我们的源站 IP、改 Host 头为后台子域，
  从 Cloudflare 回源段进入，**绕过我们的 Access 策略**（后台自身登录与角色校验仍然生效，不是直接越权）。
- 两种补强（任选其一，开发可实现，需 PO 在 Cloudflare 点几步）：
  1. **Access JWT 校验（#30，已实现，必做）**：后台子域每个请求由 Caddy forward_auth 到 api 校验 `Cf-Access-Jwt-Assertion`（签名 / iss / aud / 有效期），只覆盖后台子域、对主站无影响；
  2. **按 zone 的 Authenticated Origin Pulls**（上传自有客户端证书，源站 Caddy 校验）：覆盖全站，但证书轮换要人工维护。全局共享的 Cloudflare 回源证书挡不住其他 Cloudflare 账号，不采用。

## 8. 安全口径（审核 / 开发核对用）
- 后台会话 cookie：`__Host-bydp-admin.session-token`（`__Host-` 前缀由浏览器强制：仅本主机、无 Domain、Path=/、Secure），与主站 cookie 名不同；api `/admin/v1` 只认这个会话（主站会话即使被借用也进不了后台）。
- 主站页面（含用户内容）不与后台同源：后台子域只暴露 `/admin`、`/login`、`/api/auth/*` 与静态资源，其余 404。
- api 的 `/admin/v1/*` 不对外暴露（只经 admin 服务内网调用）；Access 覆盖整个后台子域。
