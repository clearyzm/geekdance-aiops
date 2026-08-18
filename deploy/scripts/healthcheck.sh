#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

failures=()
services=(postgres redis api image-worker worker web nginx)
wait_seconds="${HEALTHCHECK_WAIT_SECONDS:-120}"
deadline=$((SECONDS + wait_seconds))

while true; do
  pending=0
  for service in "${services[@]}"; do
    container_id="$(gd_compose ps -q "$service")"
    if [[ -z "$container_id" ]]; then
      pending=1
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$state" != "running" || ("$health" != "healthy" && "$health" != "none") ]]; then
      pending=1
    fi
  done
  [[ "$pending" == "0" || $SECONDS -ge $deadline ]] && break
  sleep 3
done

for service in "${services[@]}"; do
  container_id="$(gd_compose ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    failures+=("$service 容器不存在")
    continue
  fi
  state="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
  [[ "$state" == "running" ]] || failures+=("$service 状态为 $state")
  [[ "$health" == "healthy" || "$health" == "none" ]] || failures+=("$service 健康状态为 $health")
done

gd_compose exec -T postgres sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null' || \
  failures+=("PostgreSQL 查询失败")
gd_compose exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG' || \
  failures+=("Redis 查询失败")
gd_compose exec -T api sh -ec 'test -r /data/assets && test -w /data/assets' || \
  failures+=("素材卷不可读写")
asset_probe=".healthcheck-${RANDOM}-$$"
if gd_compose exec -T api sh -ec "touch '/data/assets/$asset_probe'"; then
  gd_compose exec -T worker sh -ec "test -r '/data/assets/$asset_probe'" || \
    failures+=("Worker 与 API 未共享同一素材目录")
  gd_compose exec -T nginx sh -ec "test -r '/data/assets/$asset_probe'" || \
    failures+=("Nginx 与 API 未共享同一素材目录")
  gd_compose exec -T api sh -ec "rm -f '/data/assets/$asset_probe'" || \
    failures+=("素材目录健康检查探针清理失败")
else
  failures+=("素材目录健康检查探针写入失败")
fi

domain="$(env_get APP_DOMAIN)"
tls_options=()
[[ "${HEALTHCHECK_INSECURE_TLS:-0}" == "1" ]] && tls_options+=(--insecure)
curl --fail --silent --show-error --max-time 15 "${tls_options[@]}" \
  --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" | grep -q '^ok$' || \
  failures+=("HTTPS 入口健康检查失败")
expected_release="${IMAGE_TAG:-}"
[[ -n "$expected_release" ]] || expected_release="$(env_get IMAGE_TAG)"
release_response="$(curl --fail --silent --show-error --max-time 15 "${tls_options[@]}" \
  --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" 2>/dev/null || true)"
if [[ -z "$expected_release" || "$release_response" != *"\"release\":\"$expected_release\""* ]]; then
  failures+=("线上 API 发布版本与 IMAGE_TAG 不一致")
fi
ready_response="$(curl --fail --silent --show-error --max-time 15 "${tls_options[@]}" \
  --resolve "$domain:443:127.0.0.1" "https://$domain/api/ready" 2>/dev/null || true)"
if [[ -z "$expected_release" || \
  "$ready_response" != *"\"release\":\"$expected_release\""* || \
  "$ready_response" != *"\"workerRelease\":\"$expected_release\""* || \
  "$ready_response" != *'"workerReleaseMatches":true'* ]]; then
  failures+=("API 与 Worker 发布版本不一致")
fi
web_release_response="$(curl --fail --silent --show-error --max-time 15 "${tls_options[@]}" \
  --resolve "$domain:443:127.0.0.1" "https://$domain/build-info" 2>/dev/null || true)"
if [[ -z "$expected_release" || "$web_release_response" != *"\"release\":\"$expected_release\""* ]]; then
  failures+=("Web 发布版本与 IMAGE_TAG 不一致")
fi
portal_headers="$(curl --fail --silent --show-error --head --max-time 15 "${tls_options[@]}" \
  --resolve "$domain:443:127.0.0.1" "https://$domain/login" 2>/dev/null || true)"
for required_header in \
  'Strict-Transport-Security: max-age=86400' \
  'X-Content-Type-Options: nosniff' \
  'X-Frame-Options: DENY' \
  'Referrer-Policy: strict-origin-when-cross-origin' \
  'Permissions-Policy: camera=(), microphone=(), geolocation=()'
do
  if ! grep -Fqi "$required_header" <<<"$portal_headers"; then
    failures+=("线上页面缺少安全响应头：${required_header%%:*}")
  fi
done
image_release_response="$(gd_compose exec -T image-worker python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())" \
  2>/dev/null || true)"
if [[ -z "$expected_release" || "$image_release_response" != *"\"release\":\"$expected_release\""* ]]; then
  failures+=("图片服务发布版本与 IMAGE_TAG 不一致")
fi
extension_version="$(sed -n 's/.*\"version\": \"\([^\"]*\)\".*/\1/p' \
  "$PROJECT_ROOT/extensions/xiaohongshu-draft-uploader/manifest.json" | head -1)"
extension_zip="$(mktemp)"
extension_manifest="$(mktemp)"
if [[ -z "$extension_version" ]]; then
  failures+=("无法读取源码中的多平台扩展版本")
else
  for extension_package in \
    geekdance-multi-platform-draft-uploader.zip \
    geekdance-xiaohongshu-draft-uploader.zip
  do
    if ! curl --fail --silent --show-error --max-time 30 "${tls_options[@]}" \
      --resolve "$domain:443:127.0.0.1" \
      "https://$domain/downloads/$extension_package" \
      -o "$extension_zip"; then
      failures+=("多平台扩展分发包下载失败：$extension_package")
      continue
    fi
    if ! unzip -p "$extension_zip" '*/manifest.json' >"$extension_manifest" 2>/dev/null; then
      failures+=("多平台扩展分发包无法读取：$extension_package")
      continue
    fi
    if ! grep -Fq "\"version\": \"$extension_version\"" "$extension_manifest"; then
      failures+=("线上多平台扩展版本与源码不一致：$extension_package")
    fi
    if ! grep -Fq '极客跳动 · 多平台草稿助手' "$extension_manifest"; then
      failures+=("线上扩展仍不是多平台草稿助手：$extension_package")
    fi
  done
fi
rm -f "$extension_zip" "$extension_manifest"

if [[ "${HEALTHCHECK_SKIP_EGRESS:-0}" != "1" ]] && \
  ! "$PROJECT_ROOT/deploy/scripts/check-egress-ip.sh" >/dev/null 2>&1; then
  failures+=("固定出口 IP 校验失败")
fi

disk_used="$(df -P "$PROJECT_ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
if [[ "$disk_used" =~ ^[0-9]+$ ]] && (( disk_used >= 85 )); then
  failures+=("项目磁盘使用率达到 ${disk_used}%")
fi

if ((${#failures[@]})); then
  message="极客跳动 AI 运营中心健康检查失败：$(IFS='；'; echo "${failures[*]}")"
  printf '%s\n' "$message" >&2
  webhook="$(env_get ALERT_WEBHOOK_URL)"
  if [[ -n "$webhook" ]]; then
    escaped="$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    curl --fail --silent --show-error --max-time 10 \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"$escaped\"}" "$webhook" >/dev/null || true
  fi
  exit 1
fi

info "生产服务、数据存储、HTTPS、磁盘和固定出口 IP 均正常"
