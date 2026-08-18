#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

if [[ "${1:-}" == "--to" && -n "${2:-}" ]]; then
  target="$2"
elif [[ -f "$STATE_DIR/previous-release" ]]; then
  target="$(<"$STATE_DIR/previous-release")"
else
  die "没有可用的上一发布版本"
fi
[[ "$target" =~ ^[A-Za-z0-9._-]+$ ]] || die "回滚版本格式无效"

if [[ "${REUSE_DEPLOY_LOCK:-0}" != "1" ]]; then
  acquire_lock deploy
fi

repository="$(env_get IMAGE_REPOSITORY)"
repository="${repository:-geekdance-ai-ops}"
for component in api worker web image-worker; do
  docker image inspect "$repository/$component:$target" >/dev/null 2>&1 || \
    die "本机缺少回滚镜像：$repository/$component:$target"
done

current=""
[[ -f "$STATE_DIR/current-release" ]] && current="$(<"$STATE_DIR/current-release")"
export IMAGE_TAG="$target"
gd_compose up -d --no-build --remove-orphans image-worker api worker web nginx
"$PROJECT_ROOT/deploy/scripts/healthcheck.sh"

[[ -n "$current" ]] && printf '%s\n' "$current" >"$STATE_DIR/previous-release"
printf '%s\n' "$target" >"$STATE_DIR/current-release"
chmod 0600 "$STATE_DIR/current-release"
[[ ! -f "$STATE_DIR/previous-release" ]] || chmod 0600 "$STATE_DIR/previous-release"
info "已回滚至：${target}。数据库未自动降级；如需数据回退请使用 restore.sh。"
