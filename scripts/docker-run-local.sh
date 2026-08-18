#!/usr/bin/env bash
set -euo pipefail

secret_env_overrides=()
for key in \
  OPENAI_API_KEY \
  OPENAI_IMAGE_API_KEY \
  OPENROUTER_API_KEY \
  OPENROUTER_TEXT_API_KEY \
  OPENROUTER_IMAGE_API_KEY; do
  if [[ -n "${!key:-}" ]]; then
    secret_env_overrides+=(-e "$key")
  fi
done

docker volume create geekdance_assets >/dev/null
docker volume create geekdance_rembg >/dev/null
docker rm -f geekdance-app >/dev/null 2>&1 || true

docker run -d \
  --name geekdance-app \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  --env-file .env \
  ${secret_env_overrides[@]+"${secret_env_overrides[@]}"} \
  -e NODE_ENV=production \
  -e API_PORT=4000 \
  -e PORT=3000 \
  -e HOSTNAME=0.0.0.0 \
  -e API_INTERNAL_URL=http://127.0.0.1:4000 \
  -e IMAGE_SERVICE_URL=http://127.0.0.1:8000 \
  -v geekdance_assets:/data/assets \
  -v geekdance_rembg:/home/node/.u2net \
  -p 127.0.0.1:3000:3000 \
  geekdance-ai-ops/app:local
