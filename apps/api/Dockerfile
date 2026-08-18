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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/content-engine/package.json packages/content-engine/package.json
COPY packages/channel-adapters/package.json packages/channel-adapters/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @geekdance/api...
COPY packages/shared packages/shared
COPY packages/content-engine packages/content-engine
COPY packages/channel-adapters packages/channel-adapters
COPY apps/api apps/api
RUN pnpm --filter @geekdance/shared build \
  && pnpm --filter @geekdance/channel-adapters build \
  && pnpm --filter @geekdance/api build

FROM base AS runtime
ARG APP_RELEASE=local
ENV NODE_ENV=production
ENV APP_RELEASE=$APP_RELEASE
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/content-engine /app/packages/content-engine
COPY --from=build /app/packages/channel-adapters /app/packages/channel-adapters
COPY --from=build /app/apps/api /app/apps/api
USER node
CMD ["node", "apps/api/dist/server.js"]
