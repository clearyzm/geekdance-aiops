#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

offline="${PREFLIGHT_OFFLINE:-0}"
required_commands=(docker curl openssl tar sed awk)
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || die "缺少命令：$command_name"
done

docker info >/dev/null 2>&1 || die "Docker 服务未运行"
docker compose version >/dev/null 2>&1 || die "Docker Compose 不可用"
[[ -f "$ENV_FILE" ]] || die "请先从 .env.production.example 创建 .env.production"
[[ ! -L "$ENV_FILE" ]] || die ".env.production 不允许是符号链接"

mode="$(file_mode "$ENV_FILE")"
if [[ "$mode" != "600" && "$mode" != "400" ]]; then
  die ".env.production 权限必须是 0600 或 0400，当前为 $mode"
fi

required_keys=(
  APP_DOMAIN APP_ORIGIN LETSENCRYPT_EMAIL POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
  DATABASE_URL REDIS_PASSWORD REDIS_URL SESSION_SECRET
  BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD EXPECTED_EGRESS_IPV4
  BACKUP_DIR BACKUP_ENCRYPTION_KEY_FILE ASSET_PUBLIC_SECRET
  OSS_ENDPOINT OSS_BUCKET OSS_PREFIX OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
)
for key in "${required_keys[@]}"; do
  value="$(env_get "$key")"
  [[ -n "$value" ]] || die "缺少配置：$key"
  if [[ "$offline" != "1" && ( "$value" == *replace-with* || "$value" == *OPS_FILL* ) ]]; then
    die "配置仍为占位值：$key"
  fi
done

[[ "$(env_get NODE_ENV)" == "production" ]] || die "NODE_ENV 必须为 production"
[[ "$(env_get APP_DOMAIN)" == "aiops.geekdance.cn" ]] || die "APP_DOMAIN 必须为 aiops.geekdance.cn"
[[ "$(env_get APP_ORIGIN)" == "https://aiops.geekdance.cn" ]] || die "APP_ORIGIN 必须为 https://aiops.geekdance.cn"
session_secret="$(env_get SESSION_SECRET)"
postgres_password="$(env_get POSTGRES_PASSWORD)"
redis_password="$(env_get REDIS_PASSWORD)"
admin_password="$(env_get BOOTSTRAP_ADMIN_PASSWORD)"
asset_public_secret="$(env_get ASSET_PUBLIC_SECRET)"
[[ ${#session_secret} -ge 32 ]] || die "SESSION_SECRET 长度至少为 32"
[[ ${#postgres_password} -ge 20 ]] || die "POSTGRES_PASSWORD 长度至少为 20"
[[ ${#redis_password} -ge 20 ]] || die "REDIS_PASSWORD 长度至少为 20"
[[ ${#admin_password} -ge 12 ]] || die "管理员临时密码长度至少为 12"
[[ ${#asset_public_secret} -ge 32 ]] || die "ASSET_PUBLIC_SECRET 长度至少为 32"
[[ "$(env_get OSS_ENDPOINT)" == https://* ]] || die "OSS_ENDPOINT 必须使用 HTTPS"

official_mode="$(env_get OFFICIAL_PUBLISHER_MODE)"
wechat_mode="$(env_get WECHAT_PUBLISHER_MODE)"
official_allow="$(env_get OFFICIAL_ALLOW_PROD)"
wechat_allow="$(env_get WECHAT_ALLOW_PROD)"
live_ack="$(env_get DEPLOY_CONFIRM_LIVE_DRAFTS)"
content_mode="$(env_get CONTENT_ENGINE_MODE)"
image_mode="$(env_get IMAGE_PROVIDER_MODE)"
[[ "$official_mode" =~ ^(off|mock|live)$ ]] || die "OFFICIAL_PUBLISHER_MODE 无效"
[[ "$wechat_mode" =~ ^(off|mock|live)$ ]] || die "WECHAT_PUBLISHER_MODE 无效"
[[ "$content_mode" =~ ^(mock|mock_geekhome|openrouter|openai)$ ]] || die "CONTENT_ENGINE_MODE 无效"
[[ "$image_mode" =~ ^(mock|openrouter|openai)$ ]] || die "IMAGE_PROVIDER_MODE 无效"
[[ "$official_allow" =~ ^(true|false)$ ]] || die "OFFICIAL_ALLOW_PROD 必须是 true 或 false"
[[ "$wechat_allow" =~ ^(true|false)$ ]] || die "WECHAT_ALLOW_PROD 必须是 true 或 false"
[[ "$live_ack" =~ ^(true|false)$ ]] || die "DEPLOY_CONFIRM_LIVE_DRAFTS 必须是 true 或 false"

if [[ "$content_mode" == "openrouter" ]]; then
  [[ -n "$(env_get OPENROUTER_TEXT_API_KEY)" || -n "$(env_get OPENROUTER_API_KEY)" ]] || \
    die "真实文本模式需要 OPENROUTER_TEXT_API_KEY（或兼容项 OPENROUTER_API_KEY）"
fi
if [[ "$content_mode" == "openai" ]]; then
  openai_api_key="$(env_get OPENAI_API_KEY)"
  openai_base_url="$(env_get OPENAI_BASE_URL)"
  openai_text_model="$(env_get OPENAI_TEXT_MODEL)"
  openai_research_fallback_model="$(env_get OPENAI_RESEARCH_FALLBACK_MODEL)"
  [[ -n "$openai_research_fallback_model" ]] || \
    openai_research_fallback_model="$(env_get OPENAI_RESEARCH_MODEL)"
  openai_reasoning_effort="$(env_get OPENAI_REASONING_EFFORT)"
  [[ -n "$openai_api_key" ]] || die "OpenAI 官方文本模式需要 OPENAI_API_KEY"
  if [[ "$offline" != "1" ]]; then
    [[ "$openai_api_key" != *OPS_FILL* && "$openai_api_key" != *replace-with* ]] || \
      die "OPENAI_API_KEY 仍为占位值"
  fi
  [[ "$openai_base_url" == "https://api.openai.com/v1" ]] || \
    die "OPENAI_BASE_URL 必须为 https://api.openai.com/v1"
  [[ "$openai_text_model" == "gpt-5.6-sol" ]] || \
    die "OPENAI_TEXT_MODEL 必须为 gpt-5.6-sol"
  [[ -n "$openai_research_fallback_model" ]] || \
    die "缺少 OPENAI_RESEARCH_FALLBACK_MODEL"
  [[ "$openai_reasoning_effort" =~ ^(none|low|medium|high|xhigh|max)$ ]] || \
    die "OPENAI_REASONING_EFFORT 无效"
fi
if [[ "$image_mode" == "openrouter" ]]; then
  [[ -n "$(env_get OPENROUTER_IMAGE_API_KEY)" || -n "$(env_get OPENROUTER_API_KEY)" ]] || \
    die "真实图片模式需要 OPENROUTER_IMAGE_API_KEY（或兼容项 OPENROUTER_API_KEY）"
fi
if [[ "$image_mode" == "openai" ]]; then
  openai_image_key="$(env_get OPENAI_IMAGE_API_KEY)"
  [[ -n "$openai_image_key" ]] || openai_image_key="$(env_get OPENAI_API_KEY)"
  [[ -n "$openai_image_key" ]] || \
    die "OpenAI 官方图片模式需要 OPENAI_IMAGE_API_KEY（或兼容项 OPENAI_API_KEY）"
  [[ "$(env_get OPENAI_IMAGE_BASE_URL)" == "https://api.openai.com/v1" ]] || \
    die "OPENAI_IMAGE_BASE_URL 必须为 https://api.openai.com/v1"
  [[ "$(env_get OPENAI_IMAGE_MODEL)" == "gpt-image-2" ]] || \
    die "OPENAI_IMAGE_MODEL 必须为 gpt-image-2"
fi
if [[ "$content_mode" == "mock_geekhome" || "$content_mode" == "openrouter" || "$content_mode" == "openai" ]]; then
  [[ -n "$(env_get GEEKHOME_MATERIAL_TOKEN)" ]] || die "真实素材模式需要 GEEKHOME_MATERIAL_TOKEN"
fi
if [[ "$official_mode" == "live" || "$wechat_mode" == "live" ]]; then
  [[ "$live_ack" == "true" ]] || die "真实草稿适配器需要 DEPLOY_CONFIRM_LIVE_DRAFTS=true"
fi
if [[ "$official_mode" == "live" && "$official_allow" != "true" ]]; then
  die "官网 live 模式需要 OFFICIAL_ALLOW_PROD=true"
fi
if [[ "$official_mode" == "live" && -z "$(env_get OFFICIAL_ADMIN_TOKEN)" ]]; then
  [[ -n "$(env_get OFFICIAL_ADMIN_USERNAME)" && -n "$(env_get OFFICIAL_ADMIN_PASSWORD)" ]] || \
    die "官网 live 模式需要 Token 或完整的服务账号凭据"
fi
if [[ "$wechat_mode" == "live" && "$wechat_allow" != "true" ]]; then
  die "公众号 live 模式需要 WECHAT_ALLOW_PROD=true"
fi
if [[ "$wechat_mode" == "live" ]]; then
  [[ -n "$(env_get WECHAT_APP_ID)" && -n "$(env_get WECHAT_APP_SECRET)" ]] || \
    die "公众号 live 模式需要 AppID 与 AppSecret"
fi

if [[ "$offline" != "1" ]]; then
  expected_ip="$(env_get EXPECTED_EGRESS_IPV4)"
  [[ "$expected_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "EXPECTED_EGRESS_IPV4 格式无效"
  IFS=. read -r ip1 ip2 ip3 ip4 <<<"$expected_ip"
  for octet in "$ip1" "$ip2" "$ip3" "$ip4"; do
    decimal_octet=$((10#$octet))
    ((decimal_octet >= 0 && decimal_octet <= 255)) || die "EXPECTED_EGRESS_IPV4 格式无效"
  done
  [[ "$expected_ip" != 203.0.113.* ]] || die "EXPECTED_EGRESS_IPV4 仍是文档示例地址"

  backup_key="$(env_get BACKUP_ENCRYPTION_KEY_FILE)"
  [[ -f "$backup_key" ]] || die "备份加密密钥文件不存在：$backup_key"
  key_mode="$(file_mode "$backup_key")"
  [[ "$key_mode" == "600" || "$key_mode" == "400" ]] || die "备份密钥权限必须为 0600 或 0400"

  cert_dir="$STATE_DIR/letsencrypt/live/aiops.geekdance.cn"
  [[ -s "$cert_dir/fullchain.pem" && -s "$cert_dir/privkey.pem" ]] || \
    die "TLS 证书尚未准备，请先执行 bootstrap-tls.sh"
fi

"$PROJECT_ROOT/deploy/scripts/check-public-asset-route.sh" \
  "$PROJECT_ROOT/deploy/nginx/conf.d/aiops.geekdance.cn.conf"
gd_compose config --quiet
info "生产部署前检查通过（offline=${offline}）"
