#!/usr/bin/env bash
set -Eeuo pipefail

pids=()

load_env_file() {
  local env_file=${1:-/app/.env}
  local line key value

  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "${line#"${line%%[![:space:]]*}"}" == \#* ]] && continue

    line=${line#export }
    [[ "$line" == *=* ]] || continue

    key=${line%%=*}
    value=${line#*=}
    key=${key//[[:space:]]/}

    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -z "${!key+x}" ]] || continue

    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value=${value:1:${#value}-2}
    fi

    export "$key=$value"
  done < "$env_file"
}

default_gateway_ip() {
  local destination gateway

  while read -r _ destination gateway _; do
    [[ "$destination" == "00000000" ]] || continue
    printf "%d.%d.%d.%d\n" \
      "$((16#${gateway:6:2}))" \
      "$((16#${gateway:4:2}))" \
      "$((16#${gateway:2:2}))" \
      "$((16#${gateway:0:2}))"
    return 0
  done < /proc/net/route

  return 1
}

normalize_host_gateway_urls() {
  local gateway key value

  if command -v getent >/dev/null 2>&1 && getent hosts host.docker.internal >/dev/null 2>&1; then
    return 0
  fi

  gateway=$(default_gateway_ip) || return 0

  for key in DATABASE_URL REDIS_URL; do
    value=${!key:-}
    [[ "$value" == *host.docker.internal* ]] || continue
    export "$key=${value//host.docker.internal/$gateway}"
  done
}

shutdown() {
  local status=${1:-0}
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit "$status"
}

trap 'shutdown 143' INT TERM
trap 'shutdown $?' EXIT

load_env_file /app/.env
normalize_host_gateway_urls

(
  cd /app/services/image-worker
  exec /opt/image-worker-venv/bin/uvicorn app:app --host 0.0.0.0 --port "${IMAGE_WORKER_PORT:-8000}"
) &
pids+=("$!")

node /app/apps/api/dist/server.js &
pids+=("$!")

node /app/apps/worker/dist/index.js &
pids+=("$!")

(
  cd /app/web-standalone
  exec node apps/web/server.js
) &
pids+=("$!")

set +e
wait -n "${pids[@]}"
status=$?
set -e
shutdown "$status"
