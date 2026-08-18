#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

expected="$(env_get EXPECTED_EGRESS_IPV4)"
[[ -n "$expected" ]] || die "EXPECTED_EGRESS_IPV4 未配置"
actual="$(gd_compose --profile ops run --rm --no-deps egress-check 2>/dev/null | tr -d '[:space:]')"
[[ "$actual" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "无法获得有效的容器出口 IPv4"
if [[ "$actual" != "$expected" ]]; then
  die "固定出口 IP 不匹配（期望 ${expected}，实际 ${actual}）"
fi
info "容器固定出口 IP 校验通过：$actual"
