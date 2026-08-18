#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
run_id="${$}-$(date +%s)"
postgres_container="geekdance-smoke-postgres-$run_id"
redis_container="geekdance-smoke-redis-$run_id"
runtime_dir="$(mktemp -d)"
assets_dir="$runtime_dir/assets"
api_log="$runtime_dir/api.log"
worker_log="$runtime_dir/worker.log"
api_pid=""
worker_pid=""

cleanup() {
  [[ -z "$worker_pid" ]] || kill "$worker_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  docker rm -f "$postgres_container" "$redis_container" >/dev/null 2>&1 || true
  if [[ "${KEEP_ISOLATED_REGRESSION_ARTIFACTS:-0}" == "1" ]]; then
    printf '保留隔离回归日志：%s\n' "$runtime_dir" >&2
  else
    rm -rf "$runtime_dir"
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$assets_dir"

# The isolated runtime starts compiled API and Worker artifacts. Build them
# here so the command always verifies the current source tree instead of a
# stale dist directory left by an earlier run.
cd "$project_root"
pnpm --filter @geekdance/api build
pnpm --filter @geekdance/worker build

docker run -d --name "$postgres_container" \
  -e POSTGRES_DB=geekdance_ops \
  -e POSTGRES_USER=geekdance_ops \
  -e POSTGRES_PASSWORD=isolated-regression-only \
  -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
docker run -d --name "$redis_container" \
  -p 127.0.0.1::6379 redis:7-alpine \
  redis-server --appendonly no >/dev/null

postgres_port="$(docker port "$postgres_container" 5432/tcp | sed 's/.*://')"
redis_port="$(docker port "$redis_container" 6379/tcp | sed 's/.*://')"
database_url="postgresql://geekdance_ops:isolated-regression-only@127.0.0.1:$postgres_port/geekdance_ops"
redis_url="redis://127.0.0.1:$redis_port"
api_port="$((41000 + ($$ % 1000)))"
api_base_url="http://127.0.0.1:$api_port"
release="isolated-$run_id"
image_service_url="${IMAGE_SERVICE_URL:-http://127.0.0.1:8000}"

for _ in $(seq 1 60); do
  if docker exec "$postgres_container" pg_isready -U geekdance_ops -d geekdance_ops >/dev/null 2>&1 && \
    docker exec "$redis_container" redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 1
done
docker exec "$postgres_container" pg_isready -U geekdance_ops -d geekdance_ops >/dev/null
docker exec "$redis_container" redis-cli ping | grep -q PONG

common_env=(
  APP_RELEASE="$release"
  NODE_ENV=test
  DATABASE_URL="$database_url"
  REDIS_URL="$redis_url"
  CONTENT_QUEUE_NAME="content-smoke-$run_id"
  AUTOMATION_QUEUE_NAME="automation-smoke-$run_id"
  IMAGE_QUEUE_NAME="image-smoke-$run_id"
  ASSET_STORAGE_DIR="$assets_dir"
  ASSET_PUBLIC_SECRET=isolated-regression-secret-32-bytes-minimum
  ASSET_PUBLIC_BASE_URL="$api_base_url/api/public/assets"
  CONTENT_ENGINE_MODE=mock
  IMAGE_PROVIDER_MODE=mock
  GEEKHOME_MATERIAL_MCP_URL=https://mock.geekhome.local/material
  GEEKHOME_MATERIAL_TOKEN=isolated-regression-token
  OFFICIAL_PUBLISHER_MODE=mock
  OFFICIAL_ALLOW_PROD=false
  WECHAT_PUBLISHER_MODE=mock
  WECHAT_ALLOW_PROD=false
  BOOTSTRAP_ADMIN_EMAIL=stage-regression@geekdance.local
  BOOTSTRAP_ADMIN_NAME=隔离回归管理员
  BOOTSTRAP_ADMIN_PASSWORD=StageRegressionOnly1234
  SMOKE_ADMIN_PERMANENT_PASSWORD=StageRegressionReady5678
  SESSION_SECRET=isolated-regression-session-secret-at-least-32-bytes
  APP_ORIGIN="$api_base_url"
  API_PORT="$api_port"
  TRUST_PROXY_HOPS=0
  IMAGE_SERVICE_URL="$image_service_url"
  GEEKDANCE_LOGO_PATH="$project_root/apps/web/public/brand/geekdance-logo.png"
  GEEKDANCE_MASCOT_PATH="$project_root/apps/web/public/brand/geekdance-mascot.png"
  WECHAT_PROMO_BOARD_PATH="$project_root/apps/web/public/brand/geekdance-promo-board.png"
  WECHAT_BRAND_LOGO_PATH="$project_root/apps/web/public/brand/geekdance-logo.png"
  WECHAT_CONTACT_QR_PATH="$project_root/apps/web/public/brand/geekdance-contact-qr.png"
  WECHAT_COVER_LOCKUP_PATH="$project_root/apps/web/public/brand/geekdance-cover-lockup.png"
)

env "${common_env[@]}" node apps/api/dist/server.js >"$api_log" 2>&1 &
api_pid="$!"
env "${common_env[@]}" node apps/worker/dist/index.js >"$worker_log" 2>&1 &
worker_pid="$!"

for _ in $(seq 1 90); do
  if curl -fsS --max-time 2 "$api_base_url/api/ready" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null || ! kill -0 "$worker_pid" 2>/dev/null; then
    printf '隔离服务提前退出\nAPI:\n' >&2
    tail -80 "$api_log" >&2 || true
    printf 'Worker:\n' >&2
    tail -80 "$worker_log" >&2 || true
    exit 1
  fi
  sleep 1
done
curl -fsS --max-time 5 "$api_base_url/api/ready" | \
  grep -Fq "\"workerReleaseMatches\":true"

# Re-run the complete migration list twice against the live isolated database.
# Every migration is required to be idempotent because production instances
# can restart independently during rolling deployment.
env "${common_env[@]}" node --input-type=module -e \
  'const { migrate, db } = await import("./apps/api/dist/database.js"); await migrate(); await migrate(); await db.end();'

smoke_env=(
  "${common_env[@]}"
  API_BASE_URL="$api_base_url"
  SMOKE_POSTGRES_CONTAINER="$postgres_container"
  SMOKE_POSTGRES_USER=geekdance_ops
  SMOKE_POSTGRES_DB=geekdance_ops
)
env "${smoke_env[@]}" node scripts/smoke-stage7.mjs
env "${smoke_env[@]}" node scripts/smoke-stage9.mjs
env "${smoke_env[@]}" node scripts/smoke-stage6.mjs

printf '隔离全流程回归通过（数据库、Redis、素材与账号均为临时环境）\n'
