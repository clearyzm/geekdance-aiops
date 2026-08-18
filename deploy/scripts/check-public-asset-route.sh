#!/usr/bin/env sh
set -eu

config_file="${1:-deploy/nginx/conf.d/aiops.geekdance.cn.conf}"

grep -Fq "upstream geekdance_ops_api" "$config_file"
grep -Fq "client_max_body_size 22m;" "$config_file"
grep -Fq "location ^~ /api/public/assets/" "$config_file"
grep -A8 -F "location ^~ /api/public/assets/" "$config_file" |
  grep -Fq "proxy_pass http://geekdance_ops_api;"
for upload_route in "/api/assets/" "/api/attachments/"; do
  grep -A12 -F "location ^~ $upload_route" "$config_file" |
    grep -Fq "proxy_pass http://geekdance_ops_api;"
  grep -A12 -F "location ^~ $upload_route" "$config_file" |
    grep -Fq "proxy_request_buffering off;"
done
grep -A8 -F "location ^~ /_internal/public-assets/" "$config_file" |
  grep -Fq "alias /data/assets/;"
grep -A8 -F "location ^~ /_internal/public-assets/" "$config_file" |
  grep -Fq "X-Asset-Delivery nginx-sendfile"

echo "Public assets and multipart uploads use direct API routes; files use Nginx sendfile delivery."
