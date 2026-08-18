ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APP_RELEASE=local

FROM ${NODE_IMAGE} AS base
ARG NPM_REGISTRY
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV npm_config_registry=$NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
  && pnpm config set registry "$NPM_REGISTRY" \
  && pnpm config set fetch-retries 5 \
  && pnpm config set fetch-retry-maxtimeout 120000 \
  && pnpm config set fetch-timeout 600000
WORKDIR /app

FROM base AS build
ARG APP_RELEASE=local
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @geekdance/web
COPY apps/web apps/web
COPY extensions/xiaohongshu-draft-uploader extensions/xiaohongshu-draft-uploader
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
ENV APP_RELEASE=$APP_RELEASE
RUN pnpm --filter @geekdance/web build

FROM ${NODE_IMAGE} AS runtime
ARG APP_RELEASE=local
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
ENV APP_RELEASE=$APP_RELEASE
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
CMD ["node", "apps/web/server.js"]
