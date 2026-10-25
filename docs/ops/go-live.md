# 上线手册（go-live）

> HANDOVER §9 上线前置的点击级步骤。**本文件分批补齐**：目前只写好「备份」一节（#6 / #7 R2 硬化）；
> 生产落位（#15 / #28）定了之后，开发再补「服务器准备 → 部署 → 一条命令自检 → 回滚演练」各节。
> 全程不需要把任何密钥贴进对话：私钥 / 令牌只用文本编辑器写进文件，开发只看「通过 / 失败」。

---

## 备份（#6 · #7）

### 结果是什么样
- 服务器每天 UTC 18:30（北京时间次日 02:30）把数据库导出、**用你的公钥加密**后上传到 Cloudflare R2 的 `bydp-backup` 桶。
- **私钥只在你手里**（离线保管）：服务器、R2、开发会话都拿不到，备份即使泄露也打不开。
- 桶开了「锁定」：备份上传后 30 天内谁都删不掉、改不了（服务器被攻破也删不了历史备份）。
- 备份失败或超过 26 小时没有成功备份 → Telegram 告警推送给管理员。
- 每月做一次恢复演练：在你自己电脑上用私钥把最新备份恢复到临时数据库，逐表核对行数，看到「恢复演练通过」即可。

### 第 1 步：生成备份密钥（PO 本机，约 3 分钟，一次性）
1. 打开 Mac 的「终端」，粘贴运行：`brew install age`（已装过会提示已安装）。
2. 运行：`mkdir -p ~/bydp-keys && age-keygen -o ~/bydp-keys/bydp-backup.key`
   - 屏幕会打印一行 `Public key: age1…`——这是**公钥**，不是密钥，可以直接复制发给开发。
   - `~/bydp-keys/bydp-backup.key` 是**私钥**：**不要发给任何人、不要贴进任何会话**。
3. 离线保管私钥（至少两份）：
   - 拷到一个加密 U 盘（或打印出来放保险柜）；
   - 另存到你的密码管理器（如 1Password / Bitwarden 的「安全笔记」，整段文件内容粘进去）。
   - 两份都放好后，可删掉电脑上的副本（演练时再从保管处取回）。**私钥丢了 = 所有备份都打不开。**
4. 把 `Public key: age1…` 那一行发给开发（或自己填进服务器 `deploy/.env.prod.input` 的 `BACKUP_AGE_RECIPIENT=`），开发重跑部署后生效。

### 第 2 步：拆分 R2 令牌（PO，Cloudflare 控制台，约 5 分钟）
现在证据与备份共用一个令牌；拆成三个，各管各的桶：
1. Cloudflare 控制台左侧 **R2** → 右上 **Manage R2 API Tokens** → **Create API token**：
   - 名称 `bydp-evidence`，权限 **Object Read & Write**，**Specify bucket(s)** 只选 `bydp-evidence` → 创建。
     生成的 Access Key ID / Secret 用文本编辑器替换服务器 `.env.prod.input` 里的 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。
   - 名称 `bydp-backup-writer`，权限 **Object Read & Write**，只选 `bydp-backup` → 创建。
     填进 `.env.prod.input` 的 `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY`。
   - 名称 `bydp-backup-restore`，权限 **Object Read only**，只选 `bydp-backup` → 创建。
     这一对**不放服务器**：填进你电脑上的 `~/bydp-keys/restore.env`（内容见第 4 步），只用于恢复演练。
2. 三个都填好后，回到 **Manage R2 API Tokens** 把原来那个共用令牌 **Delete**。
3. 对开发说「#R2 令牌已拆」，开发重跑部署并做一次备份自检（只看通过 / 失败）。

### 第 3 步：桶锁（PO，约 2 分钟）
1. **R2** → 点 `bydp-backup` → **Settings** → **Bucket lock rules** → **Add rule**：
   - Rule name：`keep-30-days`；Prefix：**`postgres/bydp-`**（只锁备份本体与清单）；Retention：**30 days** → Save。
   - **注意前缀不要写成 `postgres/`**：那样会把每天要覆盖的 `postgres/LATEST`（最新备份指针）也锁住，第二天起备份上传失败。
     LATEST 不锁：即使被篡改，恢复演练会校验文件名格式并从被锁住的本体取数据。
2. **Settings** → **Object lifecycle rules** → **Add rule**：Prefix **`postgres/bydp-`**，**Delete objects after 90 days**（过了锁定期自动清理，控制费用）→ Save。

### 第 4 步：恢复演练（PO 本机，每月一次，约 5 分钟）
前提：电脑已装 Docker Desktop（#1 已装）并处于运行状态。
1. 在 `~/bydp-keys/restore.env` 写入（用文本编辑器，值来自第 2 步的只读令牌与 R2 页面的账户端点）：
   ```
   R2_ENDPOINT=https://<账户ID>.r2.cloudflarestorage.com
   R2_BUCKET_BACKUP=bydp-backup
   R2_RESTORE_ACCESS_KEY_ID=…
   R2_RESTORE_SECRET_ACCESS_KEY=…
   ```
2. 把私钥从保管处放回 `~/bydp-keys/bydp-backup.key`。
3. 在项目目录运行：
   ```
   bash scripts/restore-drill.sh --env-file ~/bydp-keys/restore.env --identity ~/bydp-keys/bydp-backup.key
   ```
4. 看到每行「✅ 通过」和最后「—— 恢复演练通过」即完成；把输出最后 5 行发给开发存档（不含任何密钥）。
5. 演练完可再次删除电脑上的私钥副本。

---

## 生产服务器与正式部署（#15 选 A：独立 EC2 · #6 · #10）

> 顺序：①建服务器 → ②SSH 2222 → ③填配置 → ④首次部署（灰云签证书）→ ⑤Cloudflare 橙云 + Access → ⑥防火墙 → ⑦备份 → ⑧一条命令自检 → ⑨回滚演练 → ⑩上线放行。
> 前提（PO 已决定或待定）：正式主站域名（下文以 `northx.vip` 为例）与后台子域（`admin.northx.vip`）；Telegram 登录用哪个 Bot（见 ③ 注）。

### ① 建正式服务器（PO，AWS 控制台，约 10 分钟）
1. AWS 控制台右上角区域选 **亚太（新加坡）ap-southeast-1**（与测试站同区）→ **EC2 → 启动实例**：
   - 名称：`bydp-prod`
   - 系统镜像：**Ubuntu Server 24.04 LTS**（64 位 x86）
   - 实例类型：**t3.medium**（4GB 内存，与测试站相同）
   - 密钥对：**创建新密钥对** → 名称 `bydp-prod`、类型 RSA、格式 `.pem` → 下载后放到 `~/.ssh/bydp-prod.pem`（#10：正式环境用全新密钥，不复用测试站的）。终端执行一次 `chmod 600 ~/.ssh/bydp-prod.pem`。**不要发给任何会话**。
   - 网络设置 → 编辑 → **创建安全组** `bydp-prod-sg`，入站规则：SSH 22（来源：我的 IP）、自定义 TCP **2222**（0.0.0.0/0）、HTTP 80（0.0.0.0/0）、HTTPS 443（0.0.0.0/0）。
     80/443 先对全网开放（首次签证书需要），第 ⑥ 步由服务器防火墙收紧到只认 Cloudflare。
   - 配置存储：**60 GiB gp3**（测试站 38GB 曾因构建缓存告急）
   - 高级详细信息（展开）：**元数据版本 = 仅 V2（需要令牌）**，**元数据响应跳数限制 = 1**（与测试站 #12 相同）
   - 右侧 **启动实例**。
2. **弹性 IP**：EC2 → 网络与安全 → 弹性 IP → 分配弹性 IP 地址 → 分配 → 选中它 → 操作 → **关联弹性 IP 地址** → 实例选 `bydp-prod` → 关联。记下这个 IP（下称「正式机 IP」）。
3. 告诉开发：「正式机已建，IP 是 x.x.x.x」（IP 不是密钥，可以直接发）。

### ② 开 SSH 2222（PO，约 3 分钟）
与测试站相同：EC2 → 选 `bydp-prod` → 连接 → EC2 Instance Connect → 连接，在网页终端粘贴 [deploy/README.md](../../deploy/README.md) 顶部那一整行，看到「✅ 通过」即可。之后开发用 `ssh -p 2222 -i ~/.ssh/bydp-prod.pem` 连接。

### ③ 正式配置（PO 填密钥，开发上传）
1. 在 Cloudflare → R2 → **Create bucket** 新建两个**正式站专用桶** `bydp-prod-evidence`、`bydp-prod-backup`（不与测试站 `bydp-evidence` / `bydp-backup` 共用：否则两边备份的「最新指针」互相覆盖、证据混在一起）。本文「备份」一节第 2–4 步里的桶名，正式站一律换成这两个。
   然后把模板 [docs/ops/prod.env.input.template](prod.env.input.template) 复制为你电脑上的 `~/bydp-keys/prod.env.input`（终端：`cp docs/ops/prod.env.input.template ~/bydp-keys/prod.env.input`）。模板每一行都写了值去哪儿复制。
2. 你用文本编辑器逐项填写：Telegram Bot 令牌与用户名、Resend 令牌、R2 三个令牌中的「证据」与「备份写」两对（本文「备份」一节第 2 步）、备份公钥（#18）、`SITE_DOMAIN`、`ADMIN_HOST`、`BYDP_BEHIND_CLOUDFLARE=1`、`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`（[cloudflare-access.md](cloudflare-access.md) 第 4 节）。填完说「#23 done」，开发执行 `bash scripts/push-env-input.sh --host <正式机 IP>`：逐项校验格式（Bot 令牌会向 Telegram 核对用户名），全部通过才上传，只显示通过 / 失败、不显示任何值。
   > **Telegram Bot 注**：一个 Bot 的登录组件只能绑一个域名。现在 @BYDP_001_bot 绑的是测试站。推荐：@BYDP_001_bot 改绑正式域名（`/setdomain` → `northx.vip`），测试站另建一个测试 Bot（如 `@BYDP_test_bot`，`/setdomain` → `staging.northx.vip`；令牌填 `.env.local` 的 `STAGING_TG_BOT_TOKEN`，开发用 `scripts/staging-bot.sh` 写入测试站）。Telegram 用户 ID 跨 Bot 不变，测试站账号不受影响；只是测试站推送要对新 Bot 发一次 `/start`。另有后台专用 Bot（#17）。

### ④ 首次部署（开发，约 10 分钟）
- DNS 先**灰云**（[cloudflare-access.md](cloudflare-access.md) 第 2 节），让源站直连签发证书。
- 开发执行：`bash scripts/deploy.sh prod --host <正式机 IP>`（内部为 `bootstrap.sh --prod`：空库 → 迁移 → `seed:prod` 正式库数据守卫 → 健康检查；缺任何正式必填项即停，不会带着错配置上线）。
- 预期：最后一行「✅ 通过 ｜ https://northx.vip 返回 200 · 主站 /admin 返回 404 …」或「⚠️ 待定」（DNS 未生效，Caddy 会自动重试）。

### ⑤ Cloudflare 橙云 + Access（PO）
按 [cloudflare-access.md](cloudflare-access.md) 第 2–4 节：`@` 与 `admin` 改**橙色云** → SSL/TLS Full (strict) → WAF 大陆规则 → Access 应用（只放 PO 邮箱）。AOP（6b 节）可选，在此之后做。

### ⑥ 源站防火墙（开发）
服务器执行 `sudo bash deploy/firewall-cloudflare.sh --persist`：80/443 只接受 Cloudflare 回源，开机自动重放。之后 AWS 安全组里的 80/443 可保持 0.0.0.0/0（真正的限制在服务器上）。

### ⑦ 备份（开发 + PO）
- 开发：服务器装定时任务（`deploy/backup.sh` 头部那一行），并手动跑一次 `bash deploy/backup.sh` 确认「✅ 通过」。
- PO：桶锁与生命周期（本文「备份」一节第 3 步）；上线后第一个月内做一次恢复演练（第 4 步）。

### ⑧ 一条命令自检（开发）
服务器执行 `bash scripts/go-live-check.sh`，逐行「✅ / ❌」：服务健康 · IMDSv2 · DNS 走代理 · 证书 · cf-ray · 直连源站被拒 · 伪造国家头无效 · 后台 Access 拦截 · 防火墙 · Caddy 配置 · 正式库数据守卫 · 备份公钥 / 定时任务 / 26 小时内成功备份 · 告警通道 · robots 可收录 · 无 Basic Auth。**全部通过**才进入放行。
> **正式站禁止启用 Basic Auth**（W2#010）：Basic Auth 下 React 页面会偶发水合报错 #418 并整页重建（本地复现 9/600，无认证 0/900）。正式站公开、无门禁；若将来需要临时挡访问，用 Cloudflare Access 或测试站同款 Cookie 门禁，不用 Basic Auth。

### ⑨ 回滚演练（开发，上线前做一次）
- **代码回滚**：`bash scripts/deploy.sh prod --host <IP> --ref <上一版本提交>` → 健康检查通过 → 再 `--ref <当前版本>` 部署回来。服务器 `~/bydp/DEPLOYED_SHA` 记录当前版本。
- **跨迁移的版本不能直接回滚代码**（迁移只前进、已应用迁移禁改）：遇到含新迁移的版本出问题，按「修复后前进」处理；数据层面的恢复走下一条。
- **数据恢复**：用最近备份恢复到临时库核对（本文「备份」一节第 4 步）；确需覆盖正式库时，先停 web / api / worker，由开发按恢复演练同样的导入步骤恢复到新数据卷，经审核确认后切换（单独出操作单，不在日常流程内）。

### ⑩ 上线放行（审核出「上线放行」后）
- 条款 / 隐私政策补全【待替换】【待定】并去掉「草稿」提示与 noindex（#10）；
- 去掉 PO 待办里的上线前置全部打勾（HANDOVER §9）；
- 公告与首批真实品牌录入另行安排（`AGENT_CRAWL_ENABLED`、`SCORING_DAILY_ENABLED` 由 PO 决定何时开启，§9 #7 / #25）。
