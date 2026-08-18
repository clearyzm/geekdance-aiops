#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

legacy_volume="${ASSET_LEGACY_VOLUME_NAME:-geekdance-ai-ops-prod_asset_data}"
asset_host_value="$(env_get ASSET_HOST_DIR)"
if [[ -z "$asset_host_value" ]]; then
  asset_host_dir="/var/lib/geekdance-ai-ops/assets"
elif [[ "$asset_host_value" == /* ]]; then
  asset_host_dir="$asset_host_value"
else
  asset_host_dir="$PROJECT_ROOT/$asset_host_value"
fi

docker run --rm \
  -v "$asset_host_dir:/to" \
  alpine:3.22 sh -ec \
  'chown 1000:1000 /to && chmod 0750 /to'

if ! docker volume inspect "$legacy_volume" >/dev/null 2>&1; then
  info "未发现旧素材卷，已初始化外部素材目录：$asset_host_dir"
  exit 0
fi

info "从旧素材卷迁移尚未恢复的文件：$legacy_volume"
docker run --rm \
  -v "$legacy_volume:/from:ro" \
  -v "$asset_host_dir:/to" \
  alpine:3.22 sh -ec \
  'cp -an /from/. /to/ && chown -R 1000:1000 /to && chmod 0750 /to && find /to -type f -exec chmod 0644 {} +'
info "旧素材卷迁移完成，原卷保持不变"
