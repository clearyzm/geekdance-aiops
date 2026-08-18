import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
export const db = new Pool({ connectionString: config.DATABASE_URL, max: 10 });

const migrations = [
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS content_jobs (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE,
    created_by UUID NOT NULL REFERENCES users(id),
    topic TEXT NOT NULL,
    title TEXT,
    reader_mode TEXT NOT NULL,
    image_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    input JSONB NOT NULL,
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    qa_report JSONB,
    progress JSONB NOT NULL DEFAULT '{"stage":"queued","percent":0,"message":"任务已进入队列"}'::jsonb,
    result JSONB,
    workflow_version TEXT,
    template_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
    text_tokens INTEGER NOT NULL DEFAULT 0,
    text_cost_cents INTEGER NOT NULL DEFAULT 0,
    image_cost_cents INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{"stage":"queued","percent":0,"message":"任务已进入队列"}'::jsonb`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS result JSONB`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS workflow_version TEXT`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS template_versions JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS text_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS text_cost_cents INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS image_cost_cents INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id)`,
  `CREATE INDEX IF NOT EXISTS content_jobs_created_by_status_idx ON content_jobs(created_by, status)`,
  `CREATE INDEX IF NOT EXISTS content_jobs_deleted_at_idx ON content_jobs(deleted_at, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS job_targets (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK (target IN ('official_site', 'wechat')),
    status TEXT NOT NULL,
    external_draft_id TEXT,
    external_url TEXT,
    content_fingerprint TEXT,
    provider_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_id, target)
  )`,
  `ALTER TABLE job_targets ADD COLUMN IF NOT EXISTS provider_state JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'job_targets'::regclass
         AND conname = 'job_targets_target_check'
         AND pg_get_constraintdef(oid) LIKE '%linkedin%'
     ) THEN
       ALTER TABLE job_targets DROP CONSTRAINT IF EXISTS job_targets_target_check;
       ALTER TABLE job_targets ADD CONSTRAINT job_targets_target_check
         CHECK (target IN ('official_site', 'wechat', 'xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin'));
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS extension_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS extension_tokens_user_idx ON extension_tokens(user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS browser_channel_accounts (
    id UUID PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin')),
    extension_token_id UUID NOT NULL REFERENCES extension_tokens(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_account_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    profile_url TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (extension_token_id, channel)
  )`,
  `DO $$
   BEGIN
     ALTER TABLE browser_channel_accounts
       DROP CONSTRAINT IF EXISTS browser_channel_accounts_channel_check;
     ALTER TABLE browser_channel_accounts
       ADD CONSTRAINT browser_channel_accounts_channel_check
       CHECK (channel IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin'));
   END $$`,
  `CREATE INDEX IF NOT EXISTS browser_channel_accounts_active_idx
    ON browser_channel_accounts(channel, status, last_seen_at DESC)`,
  `CREATE TABLE IF NOT EXISTS browser_delivery_batches (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE,
    content_job_id UUID NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES job_targets(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin')),
    mode TEXT NOT NULL CHECK (mode IN ('draft', 'publish')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'partial', 'completed', 'failed', 'ambiguous', 'manual_review', 'cancelled')),
    reviewed_title TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    confirmed_by UUID REFERENCES users(id),
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `DO $$
   BEGIN
     ALTER TABLE browser_delivery_batches
       DROP CONSTRAINT IF EXISTS browser_delivery_batches_channel_check;
     ALTER TABLE browser_delivery_batches
       ADD CONSTRAINT browser_delivery_batches_channel_check
       CHECK (channel IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin'));
   END $$`,
  `ALTER TABLE browser_delivery_batches ADD COLUMN IF NOT EXISTS reviewed_title TEXT`,
  `DO $$
   BEGIN
     ALTER TABLE browser_delivery_batches
       DROP CONSTRAINT IF EXISTS browser_delivery_batches_status_check;
     ALTER TABLE browser_delivery_batches
       ADD CONSTRAINT browser_delivery_batches_status_check
       CHECK (status IN ('queued', 'running', 'partial', 'completed', 'failed', 'ambiguous', 'manual_review', 'cancelled'));
   END $$`,
  `CREATE INDEX IF NOT EXISTS browser_delivery_batches_job_idx
    ON browser_delivery_batches(content_job_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS browser_delivery_items (
    id UUID PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES browser_delivery_batches(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES browser_channel_accounts(id),
    target_account_key TEXT NOT NULL,
    target_account_name TEXT NOT NULL,
    operation_id UUID NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting_for_extension' CHECK (status IN ('waiting_for_extension', 'uploading', 'filled', 'drafted', 'published', 'failed', 'ambiguous', 'manual_review', 'cancelled')),
    claimed_by_token_id UUID REFERENCES extension_tokens(id),
    claim_expires_at TIMESTAMPTZ,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT,
    platform_content_id TEXT,
    platform_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (batch_id, account_id)
  )`,
  `ALTER TABLE browser_delivery_items ADD COLUMN IF NOT EXISTS target_account_key TEXT`,
  `ALTER TABLE browser_delivery_items ADD COLUMN IF NOT EXISTS target_account_name TEXT`,
  `UPDATE browser_delivery_items i
   SET target_account_key = COALESCE(i.target_account_key, a.client_account_key),
       target_account_name = COALESCE(i.target_account_name, a.display_name)
   FROM browser_channel_accounts a
   WHERE a.id = i.account_id
     AND (i.target_account_key IS NULL OR i.target_account_name IS NULL)`,
  `ALTER TABLE browser_delivery_items ALTER COLUMN target_account_key SET NOT NULL`,
  `ALTER TABLE browser_delivery_items ALTER COLUMN target_account_name SET NOT NULL`,
  `CREATE INDEX IF NOT EXISTS browser_delivery_items_claim_idx
    ON browser_delivery_items(status, account_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS xiaohongshu_upload_tasks (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE,
    content_job_id UUID NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
    target_id UUID NOT NULL UNIQUE REFERENCES job_targets(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'xiaohongshu' CHECK (channel IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin')),
    created_by UUID NOT NULL REFERENCES users(id),
    artifact_version INTEGER NOT NULL DEFAULT 1,
    content_fingerprint TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'waiting_for_uploader', 'uploading', 'filled', 'drafted', 'failed', 'ambiguous', 'manual_review')),
    claimed_by_token_id UUID REFERENCES extension_tokens(id),
    claim_expires_at TIMESTAMPTZ,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE xiaohongshu_upload_tasks ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'xiaohongshu'`,
  `DO $$
   BEGIN
     ALTER TABLE xiaohongshu_upload_tasks
       DROP CONSTRAINT IF EXISTS xiaohongshu_upload_tasks_channel_check;
     ALTER TABLE xiaohongshu_upload_tasks
       ADD CONSTRAINT xiaohongshu_upload_tasks_channel_check
       CHECK (channel IN ('xiaohongshu', 'zhihu', 'toutiao', 'baijiahao', 'linkedin'));
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'xiaohongshu_upload_tasks'::regclass
         AND conname = 'xiaohongshu_upload_tasks_status_check'
         AND pg_get_constraintdef(oid) LIKE '%filled%'
     ) THEN
       ALTER TABLE xiaohongshu_upload_tasks
         DROP CONSTRAINT IF EXISTS xiaohongshu_upload_tasks_status_check;
       ALTER TABLE xiaohongshu_upload_tasks
         ADD CONSTRAINT xiaohongshu_upload_tasks_status_check
         CHECK (status IN ('prepared', 'waiting_for_uploader', 'uploading', 'filled', 'drafted', 'failed', 'ambiguous', 'manual_review'));
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS xiaohongshu_upload_tasks_status_idx ON xiaohongshu_upload_tasks(status, created_at)`,
  `UPDATE browser_delivery_batches b
   SET reviewed_title = COALESCE(
     NULLIF(xt.payload #>> '{note,title}', ''),
     NULLIF(xt.payload #>> '{article,title}', ''),
     NULLIF(cj.title, ''),
     cj.topic
   )
   FROM xiaohongshu_upload_tasks xt, content_jobs cj
   WHERE xt.target_id = b.target_id AND cj.id = b.content_job_id
     AND b.reviewed_title IS NULL`,
  `ALTER TABLE browser_delivery_batches ALTER COLUMN reviewed_title SET NOT NULL`,
  `CREATE TABLE IF NOT EXISTS manual_reviews (
    id UUID PRIMARY KEY,
    content_job_id UUID NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES job_targets(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('content_quality', 'delivery_uncertain')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'confirmed_drafted', 'retrying')),
    reason_code TEXT,
    reason TEXT NOT NULL,
    review_note TEXT,
    artifact_revision JSONB,
    reviewed_by UUID REFERENCES users(id),
    external_draft_id TEXT,
    external_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )`,
  `ALTER TABLE manual_reviews ADD COLUMN IF NOT EXISTS artifact_revision JSONB`,
  `CREATE UNIQUE INDEX IF NOT EXISTS manual_reviews_one_pending_per_target_idx
    ON manual_reviews(target_id) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS manual_reviews_status_created_idx
    ON manual_reviews(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS manual_reviews_job_idx
    ON manual_reviews(content_job_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS assets (
    id UUID PRIMARY KEY,
    created_by UUID REFERENCES users(id),
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    storage_key TEXT,
    mime_type TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS asset_blobs (
    asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS image_jobs (
    id UUID PRIMARY KEY,
    operation_id UUID NOT NULL UNIQUE,
    created_by UUID NOT NULL REFERENCES users(id),
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    input JSONB NOT NULL,
    output_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    progress JSONB NOT NULL DEFAULT '{"percent":0,"message":"图片任务已进入队列"}'::jsonb,
    model TEXT,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS image_jobs_created_by_status_idx ON image_jobs(created_by, status)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY,
    actor_id UUID REFERENCES users(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    result TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS content_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_remarks TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS automation_schedules (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cron_expression TEXT NOT NULL DEFAULT '0 8 * * *',
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    template JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    last_triggered_at TIMESTAMPTZ,
    last_job_id UUID REFERENCES content_jobs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS automation_schedule_runs (
    id UUID PRIMARY KEY,
    schedule_id UUID NOT NULL REFERENCES automation_schedules(id) ON DELETE CASCADE,
    occurrence_key TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL,
    content_job_id UUID REFERENCES content_jobs(id),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (schedule_id, occurrence_key)
  )`,
  `CREATE INDEX IF NOT EXISTS automation_schedule_runs_schedule_idx ON automation_schedule_runs(schedule_id, scheduled_for DESC)`,
];

export async function migrate() {
  for (const statement of migrations) await db.query(statement);
}

export async function bootstrapAdmin() {
  const existing = await db.query("SELECT id FROM users WHERE email = $1", [
    config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
  ]);
  if (existing.rowCount) return;
  const passwordHash = await hash(config.BOOTSTRAP_ADMIN_PASSWORD, {
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  await db.query(
    `INSERT INTO users (id, email, display_name, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, 'admin', TRUE)`,
    [
      randomUUID(),
      config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
      config.BOOTSTRAP_ADMIN_NAME,
      passwordHash,
    ],
  );
}

export async function bootstrapDefaultSchedule() {
  const admin = await db.query(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1",
  );
  if (!admin.rowCount) return;
  await db.query(
    `INSERT INTO automation_schedules (id, name, enabled, cron_expression, timezone, template, created_by)
     SELECT $1, '每日 AI 热点官网草稿', FALSE, '0 8 * * *', 'Asia/Shanghai', $2::jsonb, $3
     WHERE NOT EXISTS (SELECT 1 FROM automation_schedules WHERE name = '每日 AI 热点官网草稿')`,
    [
      randomUUID(),
      JSON.stringify({
        topic:
          "根据近期 AI 应用、企业数字化与智能体相关热点，选择一个对企业业务负责人有实际价值的主题",
        readerMode: "general",
        sourceRefs: [],
        imageMode: "geekhome",
        primaryTag: "AI 应用",
        secondaryTags: ["智能体", "数字化转型"],
        targets: ["official_site"],
        remarks: "生成官网通识或趋势文章，只创建草稿，不正式发布",
      }),
      admin.rows[0].id,
    ],
  );
}
