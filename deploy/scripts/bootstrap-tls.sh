#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

acquire_lock tls
domain="$(env_get APP_DOMAIN)"
email="$(env_get LETSENCRYPT_EMAIL)"
[[ "$domain" == "aiops.geekdance.cn" ]] || die "仅允许为 aiops.geekdance.cn 申请证书"
[[ -n "$email" && "$email" != "ops@example.com" ]] || die "请配置真实的 LETSENCRYPT_EMAIL"

mkdir -p "$STATE_DIR/letsencrypt" "$STATE_DIR/certbot-www"
if [[ -s "$STATE_DIR/letsencrypt/live/$domain/fullchain.pem" ]]; then
  info "TLS 证书已存在；如需续期请运行 renew-tls.sh"
  exit 0
fi

info "将通过 80 端口申请 $domain 证书；DNS 必须已指向本机固定公网 IP"
docker run --rm \
  -p 80:80 \
  -v "$STATE_DIR/letsencrypt:/etc/letsencrypt" \
  certbot/certbot:v4.0.0 certonly --standalone \
  --non-interactive --agree-tos --no-eff-email \
  --email "$email" -d "$domain"
docker run --rm -v "$STATE_DIR/letsencrypt:/etc/letsencrypt" alpine:3.22 sh -ec \
  "chown -R 101:101 /etc/letsencrypt && find /etc/letsencrypt -type d -exec chmod 0755 {} + && find /etc/letsencrypt -type f -exec chmod 0644 {} + && find /etc/letsencrypt -type f -name 'privkey*.pem' -exec chmod 0640 {} +"
info "TLS 证书申请完成"
