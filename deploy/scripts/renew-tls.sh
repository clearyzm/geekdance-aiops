#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

acquire_lock tls
gd_compose --profile ops run --rm --no-deps certbot renew --webroot -w /var/www/certbot --quiet
docker run --rm -v "$STATE_DIR/letsencrypt:/etc/letsencrypt" alpine:3.22 sh -ec \
  "chown -R 101:101 /etc/letsencrypt && find /etc/letsencrypt -type d -exec chmod 0755 {} + && find /etc/letsencrypt -type f -exec chmod 0644 {} + && find /etc/letsencrypt -type f -name 'privkey*.pem' -exec chmod 0640 {} +"
gd_compose exec -T nginx nginx -s reload
info "TLS 续期检查完成，Nginx 已重载"
