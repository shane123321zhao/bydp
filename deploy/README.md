# BYDP 部署手册（从零部署）

一台全新的 Ubuntu 服务器 + 一个域名，按本文顺序即可起全套服务（web / admin / api / worker / tg-bot / Postgres / Redis / Meilisearch / Caddy 自动 HTTPS）。
测试环境与正式环境用同一套脚本：`bootstrap.sh --staging` / `--prod`。正式环境另有 Cloudflare、后台 Access、源站防火墙等上线前置，见 [docs/ops/go-live.md](../docs/ops/go-live.md) 与 [docs/ops/cloudflare-access.md](../docs/ops/cloudflare-access.md)。

---

## 1. 先决条件

| 项 | 要求 |
|---|---|
| 服务器 | Ubuntu 22.04 / 24.04，x86_64，内存 ≥ 4GB（推荐 t3.medium 级别），磁盘 ≥ 60GB；有一个可 sudo 的用户（文档以 `ubuntu` 为例） |
| 入站端口 | 80、443 对外开放（证书自动签发需要 80）；SSH 端口（默认 22，可另开 2222，见附录 A） |
| SSH | 本机持有该服务器的 SSH 私钥（只密钥登录；私钥文件不进仓库） |
| 本机工具 | git、bash、ssh / scp、curl、python3 |

## 2. 外部账号与 DNS（网页后台操作）

1. **域名 DNS**：为站点加一条 A 记录指向服务器 IP（如 `staging.example.com` 或主域）。正式环境还需要后台子域（如 `admin.example.com`），按 go-live.md 接入 Cloudflare。
2. **Telegram Bot**（TG 登录与推送）：在 @BotFather `/newbot` 建 Bot，记下 token 与用户名；再 `/setdomain` 选该 Bot、填站点域名；建议 `/setjoingroups` → Disable（不允许拉进群）。
3. **Resend**（邮箱登录信与通知邮件）：注册后 Domains → Add Domain 添加发信子域（如 `mail.example.com`），把它给出的 TXT / MX / DKIM 记录加到 DNS 并 Verify；创建一个仅发送权限的 API key。
4. **Cloudflare R2**（证据原文与数据库备份）：建两个桶（证据、备份），创建 API 令牌（Access Key ID / Secret / S3 Endpoint）。正式环境按 go-live.md「备份」拆分专用令牌并开桶锁。
5. **备份加密密钥（age）**：在**你自己的电脑**上生成（`age-keygen -o bydp-backup.key`；没有 age 可用一次性容器 `docker run --rm -v "$PWD":/k alpine:3.20 sh -c 'apk add -q age && age-keygen -o /k/bydp-backup.key'`），把输出的 `age1…` 公钥填到下一步的配置里；**私钥离线保管、不放服务器**——丢了备份就打不开。

## 3. 填写配置（不入库）

复制 [`deploy/env.prod.input.example`](env.prod.input.example) 为 `deploy/.env.prod.input`（权限 600），逐行填写：站点域名、Bot token 与用户名、Resend key 与发信地址、R2 四项、备份公钥等（每行都有说明）。
其余密钥（数据库各角色密码、会话密钥、盲索引 / 加密密钥、测试站门禁口令等）由 `bootstrap.sh` 首次运行时随机生成，写入服务器上的 `deploy/.env.prod`（600），**不打印**。

可选：在本机用 `bash scripts/push-env-input.sh --host <IP> --check-only` 先校验格式（Bot token 有效、R2 / 备份公钥格式等），再去掉 `--check-only` 经 SSH 上传。

## 4. 上传代码并初始化

在本机仓库根目录：

1. 写本机运维配置（`.env.local`，见 [`.env.example`](../.env.example)「运维脚本」一节；非密钥）：
   ```
   BYDP_STAGING_HOST=<服务器 IPv4>
   BYDP_STAGING_SSH_KEY=~/.ssh/<你的私钥>.pem
   ```
   正式环境用 `BYDP_PROD_SSH_KEY`，IP 由 `--host` 传入。
2. 部署（打包当前已提交版本 → 上传 → 服务器上执行 `bootstrap.sh`，等待 8 步结果）：
   ```
   bash scripts/deploy.sh staging
   bash scripts/deploy.sh prod --host <正式机 IP>
   ```
   `bootstrap.sh` 每步输出一行「✅ 通过 / ❌ 失败 + 摘要」，失败即停，可重复执行（幂等：已有密钥不重新生成、已有数据不重复写入）：
   1. 预检（系统、内存、磁盘）　2. 安装 Docker　3. 防火墙　4. 生成 `.env.prod`　5. 构建镜像
   6. 数据库：迁移 → 角色密码 → 数据（测试站灌演示数据；正式环境只跑数据守卫，不灌任何演示数据）
   7. 启动服务并健康检查　8. 对外访问检查（HTTPS 证书、测试站门禁、robots）
3. 测试站访问：浏览器打开站点会出现「测试环境 · 请输入访问口令」页，口令在服务器 `~/bydp/deploy/.env.prod` 的 `STAGING_GATE_PASSWORD`（只在服务器上查看，不要外传）。正式环境没有门禁。

## 5. 第一个管理员

后台没有「注册管理员」入口。先用要做管理员的账号在站点登录一次（TG 或邮箱），在服务器上查到它的 userId（数据库 `identity` 表，或请已有管理员在后台「角色」页查），然后：

```
cd ~/bydp/deploy
sudo docker compose -f compose.prod.yml --env-file .env.prod run --rm --no-deps migrate \
  ./node_modules/.bin/tsx scripts/grant-role.ts <userId> admin
```

角色：`admin`（管理员）、`arbitrator`（仲裁员）、`editor`（编辑）、`commerce`（商务；与仲裁员互斥）。每次授予 / 收回写操作审计日志。之后的角色变更在后台「角色」页操作。

## 6. 备份

`deploy/backup.sh`：pg_dump → gzip → age 公钥加密 → R2（另传每表行数清单）。按脚本头部说明装定时任务（建议每天一次）；未配置公钥时拒绝上传并告警。
恢复演练（在持有私钥的电脑上）：`bash scripts/restore-drill.sh --env-file <含 R2 只读令牌的文件> --identity <私钥文件>`，导入临时库并逐表核对行数。

## 7. 常用运维（服务器上，`~/bydp/deploy` 目录）

- 状态：`sudo docker compose -f compose.prod.yml --env-file .env.prod ps`
- 日志：`sudo docker compose -f compose.prod.yml --env-file .env.prod logs --tail 100 web`
- 更新版本：本机 `bash scripts/deploy.sh staging`（或 `prod --host …`）；回滚用 `--ref <提交>`（数据库迁移只前进，见 go-live.md「回滚」）
- 品牌资料导入：`pnpm db:import:brands <文件.xlsx> --requested-by <管理员 userId> --dry-run`（模板见 `docs/ops/brand-import-template.xlsx`；服务器上在 worker 容器内执行，文件经标准输入传入 `-`）
- 优惠真实价值全量重算：worker 容器内 `tsx src/cli/offers-recompute.ts [--dry-run]`

## 8. 测试环境与正式环境的安全口径

| 项 | 测试环境（`--staging`） | 正式环境（`--prod`） |
|---|---|---|
| 访问 | Caddy Cookie 门禁：无 `bydp_gate` Cookie 一律口令页，口令正确下发 30 天 Cookie；口令提交每 IP 每分钟 ≤ 10 次；`/tg/webhook`、`/v1/postback/*` 例外 | 公开；**禁止启用 Basic Auth**（已知会引发 React 水合报错 #418） |
| 收录 | robots 全站 Disallow、`X-Robots-Tag: noindex`、标题带「测试环境」 | 可收录（未定稿译本 noindex） |
| 后台 | 同域 `/admin` | 独立子域 + Cloudflare Access（go-live.md） |
| 真实 IP / 地区 | 不经 Cloudflare：Caddy 用 TCP 对端地址，丢弃客户端自带的 `CF-*` 头；应用层大陆 451 拿不到国家头，**测试站不生效** | 只信任 Cloudflare 回源段的 `CF-Connecting-IP` / `CF-IPCountry`；源站防火墙只接受 Cloudflare |
| 数据 | 演示数据 | 全新初始化，不带任何演示 / 测试数据 |
| 评分 | 每日评分默认关闭（`SCORING_DAILY_ENABLED=false`） | 按 go-live.md 开启 |

---

## 附录 A：SSH 另开 2222 端口（可选）

部分网络环境封 22 端口。可在云厂商的网页终端（如 AWS EC2 Instance Connect）里执行下面整行，让 sshd 同时监听 22 与 2222、只允许密钥登录、禁止 root；然后在安全组放行 TCP 2222。部署脚本默认用 2222。

```
sudo bash -c 'set -e; printf "Port 22\nPort 2222\nPasswordAuthentication no\nPermitRootLogin no\n" > /etc/ssh/sshd_config.d/10-bydp.conf; sshd -t; if systemctl list-unit-files ssh.socket >/dev/null 2>&1 && systemctl is-enabled ssh.socket >/dev/null 2>&1; then mkdir -p /etc/systemd/system/ssh.socket.d; printf "[Socket]\nListenStream=\nListenStream=22\nListenStream=2222\n" > /etc/systemd/system/ssh.socket.d/10-bydp.conf; systemctl daemon-reload; systemctl restart ssh.socket; fi; systemctl restart ssh; if command -v ufw >/dev/null; then ufw allow 2222/tcp >/dev/null; fi; sleep 1; if ss -ltn | grep -q ":2222 "; then echo "✅ 通过 ｜ sshd 已监听 22 与 2222，仅密钥登录、禁止 root"; else echo "❌ 失败 ｜ 2222 未监听"; fi'
```
