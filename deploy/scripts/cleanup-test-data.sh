#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

confirm=0
[[ "${1:-}" == "--confirm" ]] && confirm=1
pattern='Mock|自动化验收|第5阶段|第6阶段|第7阶段|第8阶段|stage[5-8]|mock-brand-raster|admin-private'

query() {
  gd_compose exec -T postgres psql \
    -U "$(env_get POSTGRES_USER)" \
    -d "$(env_get POSTGRES_DB)" \
    -v ON_ERROR_STOP=1 "$@"
}

info "只匹配明确测试标识：$pattern"
query -P pager=off -c "
  WITH test_jobs AS (
    SELECT id FROM content_jobs
    WHERE coalesce(title, '') ~* '$pattern'
       OR coalesce(topic, '') ~* '$pattern'
       OR input::text ~* '$pattern'
  ), test_image_jobs AS (
    SELECT id FROM image_jobs
    WHERE input::text ~* '$pattern'
       OR id::text IN (
         SELECT metadata->>'imageJobId' FROM assets
         WHERE source = 'mock' OR metadata::text ~* '$pattern'
       )
  ), test_assets AS (
    SELECT id FROM assets
    WHERE source = 'mock'
       OR metadata::text ~* '$pattern'
       OR metadata->>'contentJobId' IN (SELECT id::text FROM test_jobs)
       OR metadata->>'imageJobId' IN (SELECT id::text FROM test_image_jobs)
       OR id::text IN (
         SELECT jsonb_array_elements_text(coalesce(input->'sourceAssetIds', '[]'::jsonb))
         FROM image_jobs WHERE id IN (SELECT id FROM test_image_jobs)
       )
  )
  SELECT
    (SELECT count(*) FROM test_jobs) AS content_jobs,
    (SELECT count(*) FROM job_targets WHERE job_id IN (SELECT id FROM test_jobs)) AS channel_targets,
    (SELECT count(*) FROM test_assets) AS assets,
    (SELECT count(*) FROM test_image_jobs) AS image_jobs,
    (SELECT count(*) FROM automation_schedules WHERE name ~* '$pattern' OR template::text ~* '$pattern') AS schedules;
"

if [[ "$confirm" != "1" ]]; then
  info "当前是 dry-run，未删除任何数据。确认无误后执行：deploy/scripts/cleanup-test-data.sh --confirm"
  exit 0
fi

info "执行清理前创建完整备份"
"$PROJECT_ROOT/deploy/scripts/backup.sh"

storage_keys="$({ query -At -c "
  WITH test_jobs AS (
    SELECT id FROM content_jobs
    WHERE coalesce(title, '') ~* '$pattern'
       OR coalesce(topic, '') ~* '$pattern'
       OR input::text ~* '$pattern'
  ), test_image_jobs AS (
    SELECT id FROM image_jobs
    WHERE input::text ~* '$pattern'
       OR id::text IN (
         SELECT metadata->>'imageJobId' FROM assets
         WHERE source = 'mock' OR metadata::text ~* '$pattern'
       )
  )
  SELECT storage_key FROM assets
  WHERE storage_key IS NOT NULL
    AND (
      source = 'mock'
      OR metadata::text ~* '$pattern'
      OR metadata->>'contentJobId' IN (SELECT id::text FROM test_jobs)
      OR metadata->>'imageJobId' IN (SELECT id::text FROM test_image_jobs)
      OR id::text IN (
        SELECT jsonb_array_elements_text(coalesce(input->'sourceAssetIds', '[]'::jsonb))
        FROM image_jobs WHERE id IN (SELECT id FROM test_image_jobs)
      )
    );
"; } | sed '/^$/d')"

query -c "
  BEGIN;
  CREATE TEMP TABLE cleanup_test_jobs AS
    SELECT id FROM content_jobs
    WHERE coalesce(title, '') ~* '$pattern'
       OR coalesce(topic, '') ~* '$pattern'
       OR input::text ~* '$pattern';
  CREATE TEMP TABLE cleanup_test_image_jobs AS
    SELECT id FROM image_jobs
    WHERE input::text ~* '$pattern'
       OR id::text IN (
         SELECT metadata->>'imageJobId' FROM assets
         WHERE source = 'mock' OR metadata::text ~* '$pattern'
       );
  CREATE TEMP TABLE cleanup_test_assets AS
    SELECT id FROM assets
    WHERE source = 'mock'
       OR metadata::text ~* '$pattern'
       OR metadata->>'contentJobId' IN (SELECT id::text FROM cleanup_test_jobs)
       OR metadata->>'imageJobId' IN (SELECT id::text FROM cleanup_test_image_jobs)
       OR id::text IN (
         SELECT jsonb_array_elements_text(coalesce(input->'sourceAssetIds', '[]'::jsonb))
         FROM image_jobs WHERE id IN (SELECT id FROM cleanup_test_image_jobs)
       );
  DELETE FROM automation_schedule_runs
    WHERE content_job_id IN (SELECT id FROM cleanup_test_jobs)
       OR schedule_id IN (
         SELECT id FROM automation_schedules
         WHERE name ~* '$pattern' OR template::text ~* '$pattern'
       );
  DELETE FROM automation_schedules
    WHERE name ~* '$pattern' OR template::text ~* '$pattern';
  DELETE FROM image_jobs WHERE id IN (SELECT id FROM cleanup_test_image_jobs);
  DELETE FROM assets WHERE id IN (SELECT id FROM cleanup_test_assets);
  DELETE FROM content_jobs WHERE id IN (SELECT id FROM cleanup_test_jobs);
  COMMIT;
"

while IFS= read -r storage_key; do
  [[ -z "$storage_key" ]] && continue
  [[ "$storage_key" =~ ^[0-9a-f-]{36}\.(png|jpg|webp|pdf|docx|txt|md)$ ]] || \
    die "拒绝删除不安全的素材路径：$storage_key"
  gd_compose --profile ops run --rm --no-deps -T restore-helper \
    sh -ec 'rm -f "/restore/assets/$1"' sh "$storage_key"
done <<<"$storage_keys"

info "测试任务和关联素材已清理；正式品牌图片未改动"
