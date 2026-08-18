#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" == "0" ]] || { printf '请使用 sudo 运行此脚本\n' >&2; exit 1; }
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "$project_root" == "/opt/geekdance-ai-ops" ]] || {
  printf '正式 systemd 单元要求项目位于 /opt/geekdance-ai-ops，当前为 %s\n' "$project_root" >&2
  exit 1
}

install -m 0644 "$project_root"/deploy/systemd/*.service /etc/systemd/system/
install -m 0644 "$project_root"/deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now geekdance-ops-backup.timer geekdance-ops-health.timer geekdance-ops-tls-renew.timer
systemctl list-timers 'geekdance-ops-*' --no-pager
