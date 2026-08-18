#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.production.yml}"
STATE_DIR="$PROJECT_ROOT/deploy/state"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

info() {
  printf '[geekdance-ops] %s\n' "$*"
}

env_get() {
  local key="$1" value
  [[ -f "$ENV_FILE" ]] || die "找不到环境文件：$ENV_FILE"
  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

gd_compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

acquire_lock() {
  local name="$1"
  mkdir -p "$STATE_DIR/locks"
  LOCK_DIR="$STATE_DIR/locks/$name.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "已有同名操作正在执行：$name"
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}
