#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

acquire_lock deploy
"$PROJECT_ROOT/deploy/scripts/preflight.sh"
"$PROJECT_ROOT/deploy/scripts/migrate-assets.sh"

release="${1:-$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)}"
[[ "$release" =~ ^[A-Za-z0-9._-]+$ ]] || die "发布标识只能包含字母、数字、点、下划线和连字符"
mkdir -p "$STATE_DIR"

previous=""
if [[ -f "$STATE_DIR/current-release" ]]; then
  previous="$(<"$STATE_DIR/current-release")"
elif [[ -n "$(gd_compose ps -q api 2>/dev/null || true)" ]]; then
  previous="$(env_get IMAGE_TAG)"
fi

if [[ -n "$(gd_compose ps -q postgres 2>/dev/null || true)" ]]; then
  info "升级前创建一致性加密备份"
  "$PROJECT_ROOT/deploy/scripts/backup.sh"
fi

export IMAGE_TAG="$release"
info "构建发布 $release"
gd_compose build --pull api worker web image-worker
info "启动发布 $release"
gd_compose up -d --remove-orphans postgres redis storage-init image-worker api worker web nginx

# Nginx configuration is bind-mounted. Compose does not recreate the
# container when only the mounted file contents change, so explicitly verify
# and reload it before running the external health checks.
info "校验并重载 Nginx 入口配置"
gd_compose exec -T nginx nginx -t
gd_compose exec -T nginx nginx -s reload

if "$PROJECT_ROOT/deploy/scripts/healthcheck.sh"; then
  [[ -n "$previous" ]] && printf '%s\n' "$previous" >"$STATE_DIR/previous-release"
  printf '%s\n' "$release" >"$STATE_DIR/current-release"
  chmod 0600 "$STATE_DIR/current-release"
  [[ ! -f "$STATE_DIR/previous-release" ]] || chmod 0600 "$STATE_DIR/previous-release"
  info "发布成功：$release"
  exit 0
fi

info "新发布健康检查失败"
if [[ -n "$previous" ]]; then
  info "自动回滚至 $previous"
  REUSE_DEPLOY_LOCK=1 "$PROJECT_ROOT/deploy/scripts/rollback.sh" --to "$previous"
else
  gd_compose stop nginx web worker api image-worker || true
  die "首次发布失败，应用服务已停止；数据库和 Redis 保持运行"
fi
exit 1
