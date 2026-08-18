#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
cp "$PROJECT_ROOT/.env.production.example" "$tmp_env"
chmod 0600 "$tmp_env"

for script in "$PROJECT_ROOT"/deploy/scripts/*.sh; do
  bash -n "$script"
done

grep -Fq 'gd_compose exec -T nginx nginx -t' \
  "$PROJECT_ROOT/deploy/scripts/deploy.sh"
grep -Fq 'gd_compose exec -T nginx nginx -s reload' \
  "$PROJECT_ROOT/deploy/scripts/deploy.sh"
for required_header in \
  Strict-Transport-Security \
  X-Content-Type-Options \
  X-Frame-Options \
  Referrer-Policy \
  Permissions-Policy
do
  grep -Fq "${required_header}:" \
    "$PROJECT_ROOT/deploy/scripts/healthcheck.sh"
done
for security_header in \
  Strict-Transport-Security \
  X-Content-Type-Options \
  X-Frame-Options \
  Referrer-Policy \
  Permissions-Policy
do
  grep -Fq "key: \"$security_header\"" \
    "$PROJECT_ROOT/apps/web/next.config.ts"
done

PREFLIGHT_OFFLINE=1 ENV_FILE="$tmp_env" "$PROJECT_ROOT/deploy/scripts/preflight.sh"
config_json="$(ENV_FILE="$tmp_env" docker compose --env-file "$tmp_env" -f "$COMPOSE_FILE" config --format json)"
CONFIG_JSON="$config_json" node <<'NODE'
const config = JSON.parse(process.env.CONFIG_JSON);
const required = ['nginx', 'web', 'api', 'worker', 'image-worker', 'postgres', 'redis'];
for (const name of required) {
  if (!config.services[name]) throw new Error(`missing service: ${name}`);
}
for (const [name, service] of Object.entries(config.services)) {
  const ports = service.ports ?? [];
  if (name !== 'nginx' && ports.length) throw new Error(`${name} unexpectedly publishes a port`);
}
const published = (config.services.nginx.ports ?? [])
  .map((port) => Number(port.published))
  .sort((a, b) => a - b);
if (published.join(',') !== '80,443') throw new Error(`unexpected public ports: ${published}`);
if (config.services.api.read_only !== true || config.services.worker.read_only !== true) {
  throw new Error('application containers must use a read-only root filesystem');
}
if (config.services.api.environment?.ASSET_ACCEL_REDIRECT !== 'true') {
  throw new Error('production API must authorize assets with X-Accel-Redirect');
}
if (config.services.api.environment?.APP_RELEASE !== 'initial') {
  throw new Error('production API runtime must expose IMAGE_TAG as APP_RELEASE');
}
if (config.services.api.build?.args?.APP_RELEASE !== 'initial') {
  throw new Error('production API image must receive IMAGE_TAG as APP_RELEASE');
}
for (const serviceName of ['worker', 'web', 'image-worker']) {
  const service = config.services[serviceName];
  if (service.environment?.APP_RELEASE !== 'initial') {
    throw new Error(`${serviceName} runtime must expose IMAGE_TAG as APP_RELEASE`);
  }
  if (service.build?.args?.APP_RELEASE !== 'initial') {
    throw new Error(`${serviceName} image must receive IMAGE_TAG as APP_RELEASE`);
  }
}
if (!Object.hasOwn(config.services.nginx.networks ?? {}, 'backend')) {
  throw new Error('nginx must share the backend network with the API');
}
const nginxAssetMount = (config.services.nginx.volumes ?? []).find(
  (volume) => volume.target === '/data/assets',
);
if (
  !nginxAssetMount ||
  nginxAssetMount.type !== 'bind' ||
  nginxAssetMount.read_only !== true
) {
  throw new Error('nginx must bind-mount the asset directory read-only');
}
for (const serviceName of ['api', 'worker']) {
  const mount = (config.services[serviceName].volumes ?? []).find(
    (volume) => volume.target === '/data/assets',
  );
  if (
    !mount ||
    mount.type !== 'bind' ||
    mount.source !== nginxAssetMount.source ||
    mount.read_only === true
  ) {
    throw new Error(`${serviceName} must share the writable asset bind mount`);
  }
}
NODE

grep -q '^CONTENT_ENGINE_MODE=openai$' "$PROJECT_ROOT/.env.production.example"
grep -q '^OPENAI_BASE_URL=https://api.openai.com/v1$' "$PROJECT_ROOT/.env.production.example"
grep -q '^OPENAI_TEXT_MODEL=gpt-5.6-sol$' "$PROJECT_ROOT/.env.production.example"
grep -q '^OPENAI_RESEARCH_FALLBACK_MODEL=gpt-5.4$' "$PROJECT_ROOT/.env.production.example"
grep -q '^OPENAI_REASONING_EFFORT=medium$' "$PROJECT_ROOT/.env.production.example"
grep -q '^IMAGE_PROVIDER_MODE=openai$' "$PROJECT_ROOT/.env.production.example"
grep -q '^OFFICIAL_PUBLISHER_MODE=live$' "$PROJECT_ROOT/.env.production.example"
grep -q '^OFFICIAL_ALLOW_PROD=true$' "$PROJECT_ROOT/.env.production.example"
grep -q '^WECHAT_PUBLISHER_MODE=live$' "$PROJECT_ROOT/.env.production.example"
grep -q '^WECHAT_ALLOW_PROD=true$' "$PROJECT_ROOT/.env.production.example"
grep -q '^DEPLOY_CONFIRM_LIVE_DRAFTS=true$' "$PROJECT_ROOT/.env.production.example"

grep -A18 -F "location / {" \
  "$PROJECT_ROOT/deploy/nginx/conf.d/aiops.geekdance.cn.conf" |
  grep -Fq 'proxy_hide_header Cache-Control;'
grep -A18 -F "location / {" \
  "$PROJECT_ROOT/deploy/nginx/conf.d/aiops.geekdance.cn.conf" |
  grep -Fq 'add_header Cache-Control "private, no-store" always;'
for security_header in \
  'Strict-Transport-Security "max-age=86400" always;' \
  'X-Content-Type-Options nosniff always;' \
  'X-Frame-Options DENY always;' \
  'Referrer-Policy strict-origin-when-cross-origin always;' \
  'Permissions-Policy "camera=(), microphone=(), geolocation=()" always;'
do
  grep -A24 -F "location / {" \
    "$PROJECT_ROOT/deploy/nginx/conf.d/aiops.geekdance.cn.conf" |
    grep -Fq "add_header $security_header"
  grep -A20 -F "location /_next/static/ {" \
    "$PROJECT_ROOT/deploy/nginx/conf.d/aiops.geekdance.cn.conf" |
    grep -Fq "add_header $security_header"
done

printf '第 8 阶段离线部署验收通过\n'
