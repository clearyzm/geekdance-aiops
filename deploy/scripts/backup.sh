#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

acquire_lock backup
backup_dir="$(env_get BACKUP_DIR)"
key_file="$(env_get BACKUP_ENCRYPTION_KEY_FILE)"
[[ "$backup_dir" == /* ]] || die "BACKUP_DIR 必须是绝对路径"
[[ -f "$key_file" ]] || die "备份加密密钥不存在"
mkdir -p "$backup_dir/daily" "$backup_dir/weekly" "$backup_dir/monthly" "$backup_dir/staging"
chmod 0700 "$backup_dir" "$backup_dir/daily" "$backup_dir/weekly" "$backup_dir/monthly" "$backup_dir/staging"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging_name="backup-$timestamp"
staging="$backup_dir/staging/$staging_name"
mkdir -p "$staging"
chmod 0700 "$staging"

restore_services() {
  gd_compose up -d api worker >/dev/null 2>&1 || true
}
trap 'restore_services; rm -rf "$staging"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

info "短暂停止 API 与 Worker，以获得一致的数据库和队列备份"
gd_compose stop -t 90 worker api

gd_compose exec -T postgres sh -ec \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  >"$staging/postgres.dump"
gd_compose exec -T redis sh -ec \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE >/dev/null'

gd_compose --profile ops run --rm --no-deps -T backup-helper \
  tar -czf - -C /source/assets . >"$staging/assets.tar.gz"
gd_compose --profile ops run --rm --no-deps -T backup-helper \
  tar -czf - -C /source/redis . >"$staging/redis.tar.gz"

current_release="unknown"
[[ -f "$STATE_DIR/current-release" ]] && current_release="$(<"$STATE_DIR/current-release")"
{
  printf 'created_utc=%s\n' "$timestamp"
  printf 'release=%s\n' "$current_release"
  printf 'project=%s\n' "$(env_get COMPOSE_PROJECT_NAME)"
  printf 'format_version=1\n'
} >"$staging/manifest.txt"

restore_services
tar -C "$staging" -czf "$backup_dir/staging/$staging_name.tar.gz" .
archive="$backup_dir/daily/$staging_name.tar.gz.enc"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -pass "file:$key_file" \
  -in "$backup_dir/staging/$staging_name.tar.gz" -out "$archive"
openssl dgst -sha256 "$archive" | awk '{print $2}' >"$archive.sha256"
chmod 0600 "$archive" "$archive.sha256"

weekday="$(date -u +%u)"
monthday="$(date -u +%d)"
if [[ "$weekday" == "7" ]]; then
  cp -p "$archive" "$archive.sha256" "$backup_dir/weekly/"
fi
if [[ "$monthday" == "01" ]]; then
  cp -p "$archive" "$archive.sha256" "$backup_dir/monthly/"
fi

daily_retention="$(env_get BACKUP_DAILY_RETENTION_DAYS)"
weekly_retention="$(env_get BACKUP_WEEKLY_RETENTION_DAYS)"
monthly_retention="$(env_get BACKUP_MONTHLY_RETENTION_DAYS)"
find "$backup_dir/daily" -type f -mtime "+${daily_retention:-7}" -delete
find "$backup_dir/weekly" -type f -mtime "+${weekly_retention:-28}" -delete
find "$backup_dir/monthly" -type f -mtime "+${monthly_retention:-183}" -delete
rm -rf "$staging" "$backup_dir/staging/$staging_name.tar.gz"
trap - EXIT
rmdir "$LOCK_DIR" 2>/dev/null || true
info "加密备份完成：$archive"
