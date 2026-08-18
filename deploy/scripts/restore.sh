#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

[[ "${1:-}" == "--confirm" && -n "${2:-}" ]] || \
  die "用法：restore.sh --confirm /absolute/path/backup-*.tar.gz.enc"
archive="$2"
[[ "$archive" == /* && -f "$archive" ]] || die "备份文件不存在或不是绝对路径"
[[ -f "$archive.sha256" ]] || die "缺少 SHA-256 校验文件：$archive.sha256"

acquire_lock restore
expected_hash="$(awk '{print $1}' "$archive.sha256")"
actual_hash="$(openssl dgst -sha256 "$archive" | awk '{print $2}')"
[[ "$expected_hash" == "$actual_hash" ]] || die "备份校验失败，文件可能已损坏"

key_file="$(env_get BACKUP_ENCRYPTION_KEY_FILE)"
backup_dir="$(env_get BACKUP_DIR)"
work="$backup_dir/staging/restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$work"
chmod 0700 "$work"
trap 'rm -rf "$work"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass "file:$key_file" -in "$archive" -out "$work/backup.tar.gz"
tar -xzf "$work/backup.tar.gz" -C "$work"
for file in postgres.dump redis.tar.gz assets.tar.gz manifest.txt; do
  [[ -s "$work/$file" ]] || die "备份缺少文件：$file"
done

info "开始恢复；Web、API、Worker 和图片服务将进入维护状态"
gd_compose stop -t 90 nginx web worker api image-worker

gd_compose exec -T postgres sh -ec \
  'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
gd_compose exec -T postgres sh -ec \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' \
  <"$work/postgres.dump"

gd_compose stop -t 30 redis
gd_compose --profile ops run --rm --no-deps -T restore-helper sh -ec \
  "find /restore/redis -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf - -C /restore/redis && chown -R 999:1000 /restore/redis" \
  <"$work/redis.tar.gz"
gd_compose --profile ops run --rm --no-deps -T restore-helper sh -ec \
  "find /restore/assets -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf - -C /restore/assets && chown -R 1000:1000 /restore/assets" \
  <"$work/assets.tar.gz"

gd_compose up -d redis image-worker api worker web nginx
"$PROJECT_ROOT/deploy/scripts/healthcheck.sh"
info "备份恢复与恢复后健康检查完成"
