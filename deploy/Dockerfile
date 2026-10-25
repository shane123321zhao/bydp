# BYDP 应用镜像（D-009）：一个镜像跑 web / admin / api / worker / 迁移，按 compose 的 command 区分。
# BYDP_ENV 须在构建期给出：web 多数页面构建期静态生成，测试环境水印与 noindex 在此确定。
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
ARG BYDP_ENV=staging
# D-025：站点绝对地址（canonical / hreflang / 结构化数据）须构建期内联——静态页在此生成；由 compose 从 .env.prod 的 AUTH_URL 传入
ARG NEXT_PUBLIC_SITE_URL
# D-033：测试站顶部提示条开关（构建期；off = 不显示，缺省 on），由 compose 从 .env.prod 的 STAGING_MARK 传入
ARG STAGING_MARK=on
ENV BYDP_ENV=$BYDP_ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL STAGING_MARK=$STAGING_MARK
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bydp/web build && pnpm --filter @bydp/admin build

FROM base AS runtime
ARG BYDP_ENV=staging
# 运行期不用 pnpm（见 compose.prod.yml），关掉 corepack 的下载提示以防误触发
ENV BYDP_ENV=$BYDP_ENV NODE_ENV=production TZ=UTC COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# admin 证据沙箱预览（契约 v0.2 Q2）：PDF 由 poppler 的 pdftoppm 在子进程渲染为 PNG（不执行内嵌脚本）；图片由 sharp（npm）重编码
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
USER node
