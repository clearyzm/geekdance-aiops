ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG FONT_CDN_BASE=https://cdn.jsdelivr.net/npm/@alleyway-boop/fonts@1.0.0/fonts
ARG APT_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_TRUSTED_HOST=mirrors.aliyun.com
ARG APP_RELEASE=local

FROM ${NODE_IMAGE} AS node-base
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

FROM node-base AS node-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/content-engine/package.json packages/content-engine/package.json
COPY packages/channel-adapters/package.json packages/channel-adapters/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM node-base AS node-build
COPY --from=node-deps /app/node_modules /app/node_modules
COPY . .
ARG API_INTERNAL_URL=http://127.0.0.1:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm --filter @geekdance/shared build \
  && pnpm --filter @geekdance/content-engine build \
  && pnpm --filter @geekdance/channel-adapters build \
  && pnpm --filter @geekdance/api build \
  && pnpm --filter @geekdance/worker build \
  && pnpm --filter @geekdance/web build

FROM node-base AS runtime-base
USER root
ARG APT_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG FONT_CDN_BASE
ARG PIP_INDEX_URL
ARG PIP_TRUSTED_HOST
ENV PIP_INDEX_URL=$PIP_INDEX_URL
ENV PIP_TRUSTED_HOST=$PIP_TRUSTED_HOST
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_DEFAULT_TIMEOUT=120
RUN set -eux; \
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do \
    [ -f "$file" ] || continue; \
    sed -i \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${APT_MIRROR}|g" \
      -e "s|https://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|https://security.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|https://deb.debian.org/debian|${APT_MIRROR}|g" \
      "$file"; \
  done; \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-wqy-zenhei \
    ca-certificates \
    curl \
    woff2 \
    python3 \
    python3-pip \
    python3-venv \
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
  && fc-match 'WenQuanYi Zen Hei' | grep -q 'wqy-zenhei' \
  && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS app
ARG APP_RELEASE=local
COPY services/image-worker/requirements.txt /tmp/image-worker-requirements.txt
RUN python3 -m venv /opt/image-worker-venv \
  && /opt/image-worker-venv/bin/pip install --no-cache-dir -r /tmp/image-worker-requirements.txt \
  && rm /tmp/image-worker-requirements.txt
ENV NODE_ENV=production
ENV API_PORT=4000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV API_INTERNAL_URL=http://127.0.0.1:4000
ENV IMAGE_SERVICE_URL=http://127.0.0.1:8000
ENV APP_RELEASE=$APP_RELEASE
WORKDIR /app
COPY --from=node-build /app/node_modules /app/node_modules
COPY --from=node-build /app/packages/shared /app/packages/shared
COPY --from=node-build /app/packages/content-engine /app/packages/content-engine
COPY --from=node-build /app/packages/channel-adapters /app/packages/channel-adapters
COPY --from=node-build /app/apps/api /app/apps/api
COPY --from=node-build /app/apps/worker /app/apps/worker
COPY --from=node-build /app/apps/web/public/brand /app/apps/web/public/brand
COPY --from=node-build /app/apps/web/.next/standalone /app/web-standalone
COPY --from=node-build /app/apps/web/.next/static /app/web-standalone/apps/web/.next/static
COPY --from=node-build /app/apps/web/public /app/web-standalone/apps/web/public
COPY --from=node-build /app/.env /app/.env
COPY services/image-worker/app.py /app/services/image-worker/app.py
COPY scripts/run-app-container.sh /usr/local/bin/geekdance-run-app
RUN chmod +x /usr/local/bin/geekdance-run-app \
  && chmod 0644 /app/apps/web/public/brand/*.png \
  && fc-cache -f \
  && fc-match 'Alibaba PuHuiTi 2.0' | grep -q 'AlibabaPuHuiTi' \
  && mkdir -p /data/assets /home/node/.u2net \
  && chown -R node:node /data/assets /home/node/.u2net
USER node
EXPOSE 3000 4000 8000
CMD ["geekdance-run-app"]
