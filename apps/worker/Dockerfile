ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG FONT_CDN_BASE=https://cdn.jsdelivr.net/npm/@alleyway-boop/fonts@1.0.0/fonts
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
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile --filter @geekdance/worker...
COPY packages/shared packages/shared
COPY packages/content-engine packages/content-engine
COPY packages/channel-adapters packages/channel-adapters
COPY apps/worker apps/worker
RUN pnpm --filter @geekdance/shared build && pnpm --filter @geekdance/content-engine build && pnpm --filter @geekdance/channel-adapters build && pnpm --filter @geekdance/worker build

FROM base AS runtime
ARG APP_RELEASE=local
ARG FONT_CDN_BASE
ENV NODE_ENV=production
ENV APP_RELEASE=$APP_RELEASE
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-noto-cjk curl woff2 \
  && mkdir -p /usr/local/share/fonts/alibaba-puhuiti \
  && curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 \
    "$FONT_CDN_BASE/AlibabaPuHuiTi-2-55-Regular.woff2" \
    --output /usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-55-Regular.woff2 \
  && curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 \
    "$FONT_CDN_BASE/AlibabaPuHuiTi-2-85-Bold.woff2" \
    --output /usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-85-Bold.woff2 \
  && echo 'e03857d7e181a9201baee2edef8dc6dba054dcb42a4b763cf75bb3dbdee2b321  /usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-55-Regular.woff2' | sha256sum -c - \
  && echo 'd56c8f01d94e3dfa05fba2762750c46b847aa8e8b11c03f8b1d9bb195b422ad4  /usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-85-Bold.woff2' | sha256sum -c - \
  && woff2_decompress /usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-55-Regular.woff2 \
  && woff2_decompress /usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-85-Bold.woff2 \
  && fc-cache -f \
  && fc-match 'Alibaba PuHuiTi 2.0' | grep -q 'AlibabaPuHuiTi' \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/content-engine /app/packages/content-engine
COPY --from=build /app/packages/channel-adapters /app/packages/channel-adapters
COPY --from=build /app/apps/worker /app/apps/worker
COPY apps/web/public/brand/geekdance-promo-board.png /app/apps/web/public/brand/geekdance-promo-board.png
COPY apps/web/public/brand/geekdance-logo.png /app/apps/web/public/brand/geekdance-logo.png
COPY apps/web/public/brand/geekdance-article-illustration-logo.png /app/apps/web/public/brand/geekdance-article-illustration-logo.png
COPY apps/web/public/brand/geekdance-contact-qr.png /app/apps/web/public/brand/geekdance-contact-qr.png
COPY apps/web/public/brand/geekdance-cover-lockup.png /app/apps/web/public/brand/geekdance-cover-lockup.png
COPY apps/web/public/brand/geekdance-mascot.png /app/apps/web/public/brand/geekdance-mascot.png
RUN chmod 0644 /app/apps/web/public/brand/*.png
USER node
CMD ["node", "apps/worker/dist/index.js"]
