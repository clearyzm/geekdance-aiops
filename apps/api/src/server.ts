import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { hash } from "@node-rs/argon2";
import { Queue } from "bullmq";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import {
  createOssAssetStore,
  downloadRemoteImage,
} from "@geekdance/channel-adapters";
import {
  generateTitleCandidates,
  searchGeekHomeMaterials,
} from "@geekdance/content-engine";
import {
  automationScheduleRequestSchema,
  articleImagePlacementSchema,
  browserDraftChannelSchema,
  channelLabels,
  contentRuntimeIssues,
  contentJobRequestSchema,
  wechatEndingSchema,
  coreArticleSchema,
  workerRuntimeSnapshotSchema,
  channelSchema,
  type Channel,
  type WorkerRuntimeSnapshot,
} from "@geekdance/shared";
import { config } from "./config.js";
import { workerReleaseMatches } from "./release-health.js";
import {
  bootstrapAdmin,
  bootstrapDefaultSchedule,
  db,
  migrate,
} from "./database.js";
import { registerImageRoutes } from "./image-routes.js";
import { registerAttachmentRoutes } from "./attachment-routes.js";
import {
  recomputeDeliveryBatch,
  registerMultiAccountDeliveryRoutes,
} from "./multi-account-delivery.js";
import {
  reviewCategory,
  reviewDecisionAllowed,
  reviewedArtifactIsUsable,
  reviewReason,
} from "./manual-review-policy.js";
import {
  applyManualReviewRevision,
  type ReviewedImage,
} from "./manual-review-artifact.js";
import { resolveReviewMaterialCandidate } from "./manual-review-suggestion.js";
import {
  cancellableJobStatuses,
  cancellableTargetStatuses,
  cancellationUnsafeTargetStatuses,
  contentGenerationActiveStatuses,
  summarizeContentJobTargets,
} from "./content-job-policy.js";
import {
  getContentPreferences,
  saveContentPreferences,
} from "./content-preferences.js";
import {
  authenticate,
  authenticateExtension,
  createSession,
  destroySession,
  issueCsrf,
  hashExtensionToken,
  requireAdmin,
  requireCsrf,
  verifyPassword,
} from "./security.js";

const app = Fastify({
  // The production topology is Nginx -> Next.js -> API. The API is not
  // published outside Docker, so trusting exactly those two proxy hops keeps
  // rate limiting and audit IPs accurate without trusting arbitrary clients.
  trustProxy: config.TRUST_PROXY_HOPS,
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "body.password",
    ],
  },
  // Multipart uploads advertise a 20 MiB per-file limit. Keep the request
  // envelope slightly larger so Fastify does not reject valid files before
  // @fastify/multipart can validate them.
  bodyLimit: 22 * 1024 * 1024,
  requestIdHeader: "x-request-id",
  genReqId: () => randomUUID(),
});
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const contentQueue = new Queue(config.CONTENT_QUEUE_NAME, {
  connection: redis,
});
const automationQueue = new Queue(config.AUTOMATION_QUEUE_NAME, {
  connection: redis,
});
const imageQueue = new Queue(config.IMAGE_QUEUE_NAME, { connection: redis });
const assetStore = createOssAssetStore({
  endpoint: config.OSS_ENDPOINT,
  bucket: config.OSS_BUCKET,
  prefix: config.OSS_PREFIX,
  accessKeyId: config.OSS_ACCESS_KEY_ID,
  accessKeySecret: config.OSS_ACCESS_KEY_SECRET,
});

async function localAssetStorageReady() {
  try {
    await mkdir(config.ASSET_STORAGE_DIR, { recursive: true, mode: 0o750 });
    await access(config.ASSET_STORAGE_DIR, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
const runtimeKey = `geekdance:worker:runtime:${config.CONTENT_QUEUE_NAME}:${config.IMAGE_QUEUE_NAME}`;

async function getWorkerRuntime(): Promise<WorkerRuntimeSnapshot | null> {
  const value = await redis.get(runtimeKey);
  if (!value) return null;
  try {
    return workerRuntimeSnapshotSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

async function requireProductionContentRuntime(
  request: Pick<
    Parameters<typeof contentRuntimeIssues>[1],
    "targets" | "imageMode"
  > & { includeGeekHome?: boolean },
  reply: FastifyReply,
) {
  if (config.NODE_ENV !== "production") return true;
  const issues = contentRuntimeIssues(await getWorkerRuntime(), request);
  if (!issues.length) return true;
  reply.code(503).send({
    error: "PRODUCTION_RUNTIME_NOT_READY",
    message: issues.map((issue) => issue.message).join("；"),
    issues,
  });
  return false;
}

function contentJobView(
  row: Record<string, any>,
  targets: Array<Record<string, any>> = [],
  viewer?: NonNullable<FastifyRequest["sessionUser"]>,
  reviews: Array<Record<string, any>> = [],
  inputAttachments: Array<Record<string, any>> = [],
) {
  return {
    id: row.id,
    operationId: row.operation_id,
    topic: row.topic,
    title: row.title,
    status: row.status,
    progress: row.progress,
    input: row.input,
    inputAttachments: inputAttachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.metadata?.originalName ?? "附件",
      mimeType: attachment.mime_type,
      bytes: Number(attachment.metadata?.bytes ?? 0),
    })),
    evidence: row.evidence,
    qaReport: row.qa_report,
    result: row.result,
    templateVersions: row.template_versions,
    deletedAt: row.deleted_at,
    createdBy: {
      id: row.created_by,
      name:
        row.created_by_name ??
        (viewer?.id === row.created_by ? viewer?.name : null),
    },
    canManage:
      viewer == null || viewer.role === "admin" || row.created_by === viewer.id,
    targets: targets.map((target) => ({
      target: target.target,
      status: target.status,
      errorCode: target.error_code,
      externalDraftId: target.external_draft_id,
      externalUrl: target.external_url,
      uploadTask: target.xhs_upload_task_id
        ? {
            id: target.xhs_upload_task_id,
            status: target.xhs_upload_status,
            errorCode: target.xhs_upload_error_code,
            updatedAt: target.xhs_upload_updated_at,
          }
        : null,
    })),
    reviews: reviews.map(manualReviewView),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function manualReviewView(row: Record<string, any>) {
  return {
    id: row.id,
    contentJobId: row.content_job_id,
    targetId: row.target_id,
    target: row.target,
    category: row.category,
    status: row.status,
    reasonCode: row.reason_code,
    reason:
      row.reason === row.reason_code || !row.reason
        ? reviewReason(row)
        : row.reason,
    reviewNote: row.review_note,
    revisionApplied: Boolean(row.artifact_revision),
    externalDraftId: row.external_draft_id,
    externalUrl: row.external_url,
    job: row.topic
      ? {
          id: row.content_job_id,
          title: row.title || row.topic,
          status: row.job_status,
          createdBy: {
            id: row.created_by,
            name: row.created_by_name,
          },
        }
      : undefined,
    reviewer: row.reviewed_by
      ? { id: row.reviewed_by, name: row.reviewed_by_name }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

async function ensurePendingManualReviews(contentJobId?: string) {
  const candidates = await db.query(
    `SELECT jt.id AS target_id, jt.job_id AS content_job_id, jt.target,
            jt.error_code, jt.updated_at, cj.result,
            xt.error_code AS xhs_error_code
     FROM job_targets jt
     JOIN content_jobs cj ON cj.id = jt.job_id
     LEFT JOIN xiaohongshu_upload_tasks xt ON xt.target_id = jt.id
     WHERE jt.status IN ('manual_review', 'ambiguous')
       AND ($1::uuid IS NULL OR jt.job_id = $1)
       AND NOT EXISTS (
         SELECT 1 FROM manual_reviews mr
         WHERE mr.target_id = jt.id AND mr.status = 'pending'
       )`,
    [contentJobId ?? null],
  );
  for (const row of candidates.rows) {
    await db.query(
      `INSERT INTO manual_reviews
       (id, content_job_id, target_id, category, reason_code, reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (target_id) WHERE status = 'pending' DO NOTHING`,
      [
        randomUUID(),
        row.content_job_id,
        row.target_id,
        reviewCategory(row),
        row.error_code || row.xhs_error_code || null,
        reviewReason(row),
        row.updated_at,
      ],
    );
  }
}

const reviewArticleSchema = coreArticleSchema.refine(
  (article) =>
    article.title.trim().length > 0 &&
    article.description.trim().length > 0 &&
    article.opening.every((paragraph) => paragraph.trim().length > 0) &&
    article.sections.every(
      (section) =>
        section.heading.trim().length > 0 &&
        section.paragraphs.every((paragraph) => paragraph.trim().length > 0),
    ) &&
    (!article.observationTitle || article.observationTitle.trim().length > 0) &&
    article.observation.trim().length > 0 &&
    article.conclusion.trim().length > 0,
  "文章字段不能为空",
);

const reviewImageSchema = z
  .discriminatedUnion("source", [
    z.object({
      source: z.literal("existing"),
      url: z.string().url().max(2_048),
    }),
    z.object({ source: z.literal("asset"), assetId: z.string().uuid() }),
    z.object({
      source: z.literal("suggestion"),
      materialId: z.string().min(1).max(300),
      url: z.string().url().max(2_048),
    }),
  ])
  .and(z.object({ placement: articleImagePlacementSchema.optional() }));

const manualReviewRevisionSchema = z
  .object({
    article: reviewArticleSchema,
    images: z.array(reviewImageSchema).max(8).default([]),
    cover: reviewImageSchema.optional(),
  })
  .superRefine((revision, context) => {
    for (const [imageIndex, image] of revision.images.entries()) {
      const placement = image.placement;
      if (!placement) continue;
      if (placement.anchor === "cover" && imageIndex !== 0)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images", imageIndex, "placement"],
          message: "只有第一张图可作为封面",
        });
      if (
        "sectionIndex" in placement &&
        placement.sectionIndex >= revision.article.sections.length
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images", imageIndex, "placement"],
          message: "图片所选章节不存在",
        });
      if (
        placement.anchor === "after_opening" &&
        placement.paragraphIndex >= revision.article.opening.length
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images", imageIndex, "placement"],
          message: "图片所选开篇段落不存在",
        });
      if (
        placement.anchor === "after_section_paragraph" &&
        placement.paragraphIndex >=
          (revision.article.sections[placement.sectionIndex]?.paragraphs
            .length ?? 0)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images", imageIndex, "placement"],
          message: "图片所选段落不存在",
        });
    }
  })
  .refine(
    (revision) => JSON.stringify(revision).length <= 500_000,
    "复核内容过大",
  );

const manualReviewDecisionSchema = z.object({
  decision: z.enum([
    "approve_content",
    "reject_content",
    "confirm_drafted",
    "confirm_absent_retry",
  ]),
  note: z.string().trim().max(2_000).optional().default(""),
  externalDraftId: z.string().trim().max(300).optional(),
  externalUrl: z
    .string()
    .trim()
    .url()
    .max(2_048)
    .refine((value) => value.startsWith("https://"), "仅允许 HTTPS 地址")
    .optional(),
  artifactRevision: manualReviewRevisionSchema.optional(),
});

const reviewSelect = `SELECT mr.*, jt.target, jt.status AS target_status,
  cj.topic, cj.title, cj.status AS job_status, cj.created_by, cj.input, cj.result,
  creator.display_name AS created_by_name,
  reviewer.display_name AS reviewed_by_name
  FROM manual_reviews mr
  JOIN job_targets jt ON jt.id = mr.target_id
  JOIN content_jobs cj ON cj.id = mr.content_job_id
  JOIN users creator ON creator.id = cj.created_by
  LEFT JOIN users reviewer ON reviewer.id = mr.reviewed_by`;

async function resolveReviewedImages(
  client: import("pg").PoolClient,
  row: Record<string, any>,
  choices: z.infer<typeof reviewImageSchema>[],
  _actor: { id: string; role: string },
  rejectDuplicates = true,
) {
  const artifact = row.result?.channelArtifacts?.[row.target];
  const existing = new Map<string, ReviewedImage>();
  if (typeof artifact?.reviewedCoverUrl === "string")
    existing.set(artifact.reviewedCoverUrl, {
      id: artifact.reviewedCover?.id,
      title: artifact.reviewedCover?.title ?? "已选渠道封面",
      url: artifact.reviewedCoverUrl,
    });
  for (const asset of Array.isArray(artifact?.assets) ? artifact.assets : []) {
    const selected = asset?.selected;
    if (typeof selected?.url !== "string") continue;
    existing.set(selected.url, {
      id: typeof selected.id === "string" ? selected.id : undefined,
      title: typeof selected.title === "string" ? selected.title : "原渠道配图",
      url: selected.url,
      placement: asset?.placement,
    });
  }
  const assetIds = choices.flatMap((choice) =>
    choice.source === "asset" ? [choice.assetId] : [],
  );
  const selectedAssets = assetIds.length
    ? await client.query(
        `SELECT id, created_by, storage_key, metadata
         FROM assets
         WHERE id = ANY($1::uuid[]) AND kind = 'image' AND status = 'ready'`,
        [assetIds],
      )
    : { rows: [] as Record<string, any>[] };
  const assetsById = new Map(
    selectedAssets.rows.map((asset) => [asset.id as string, asset]),
  );
  if (!config.ASSET_PUBLIC_SECRET && assetIds.length)
    throw new Error("ASSET_PUBLIC_SECRET_MISSING");

  const suggestionChoices = choices.filter(
    (choice) => choice.source === "suggestion",
  );
  const suggestions = suggestionChoices.length
    ? await searchGeekHomeMaterials(
        {
          geekHomeUrl: config.GEEKHOME_MATERIAL_MCP_URL ?? "",
          geekHomeToken: config.GEEKHOME_MATERIAL_TOKEN ?? "",
        },
        contentJobRequestSchema.parse(row.input),
      )
    : [];
  const images = choices.map((choice): ReviewedImage => {
    if (choice.source === "existing") {
      const image = existing.get(choice.url);
      if (!image) throw new Error("REVIEW_EXISTING_IMAGE_INVALID");
      return { ...image, placement: choice.placement ?? image.placement };
    }
    if (choice.source === "suggestion") {
      const material = resolveReviewMaterialCandidate(suggestions, choice);
      if (!material?.url) throw new Error("REVIEW_SUGGESTION_EXPIRED");
      return {
        id: material.id ?? choice.materialId,
        title: material.title ?? "GeekHome 推荐素材",
        // Use the freshly resolved URL because signed OSS URLs can rotate
        // while an operator is editing the review.
        url: material.url,
        placement: choice.placement,
      };
    }
    const asset = assetsById.get(choice.assetId);
    if (!asset?.storage_key) throw new Error("REVIEW_ASSET_UNAVAILABLE");
    const signature = createHmac("sha256", config.ASSET_PUBLIC_SECRET!)
      .update(asset.id)
      .digest("hex");
    return {
      id: asset.id,
      title: String(
        asset.metadata?.displayName ??
          asset.metadata?.originalName ??
          "人工复核配图",
      ),
      url: `${config.APP_ORIGIN.replace(/\/$/, "")}/api/public/assets/${asset.id}/${signature}`,
      metadata:
        asset.metadata && typeof asset.metadata === "object"
          ? asset.metadata
          : undefined,
      placement: choice.placement,
    };
  });
  if (
    rejectDuplicates &&
    new Set(images.map((image) => image.url)).size !== images.length
  )
    throw new Error("REVIEW_IMAGE_DUPLICATED");
  return images;
}

async function queueReviewedTarget(
  contentJobId: string,
  reviewId: string,
  targetId: string,
) {
  try {
    await contentQueue.add(
      "publish-reviewed-target",
      { contentJobId, targetId },
      {
        jobId: `manual-review-${reviewId}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  } catch (error) {
    await db.query(
      `UPDATE manual_reviews SET status = 'pending', reviewed_by = NULL,
       review_note = NULL, resolved_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status IN ('approved', 'retrying')`,
      [reviewId],
    );
    await db.query(
      `UPDATE job_targets SET status = 'manual_review',
       error_code = 'REVIEW_QUEUE_SUBMIT_FAILED', updated_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [targetId],
    );
    await recomputeContentJobStatus(contentJobId);
    throw error;
  }
}

function scheduleView(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    template: row.template,
    lastTriggeredAt: row.last_triggered_at,
    lastJobId: row.last_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function syncSchedule(row: Record<string, any>) {
  if (!row.enabled) {
    await automationQueue.removeJobScheduler(row.id);
    return;
  }
  await automationQueue.upsertJobScheduler(
    row.id,
    { pattern: row.cron_expression, tz: row.timezone },
    { name: "run-content-schedule", data: { scheduleId: row.id } },
  );
}

await app.register(cookie);
await app.register(cors, {
  origin(origin, callback) {
    if (
      !origin ||
      origin === config.APP_ORIGIN ||
      origin.startsWith("chrome-extension://")
    )
      return callback(null, true);
    callback(new Error("CORS_ORIGIN_FORBIDDEN"), false);
  },
  credentials: true,
});
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
await app.register(multipart, {
  limits: { files: 1, fileSize: 20 * 1024 * 1024, fields: 8 },
});

async function healthHandler() {
  await db.query("SELECT 1");
  return { status: "ok", service: "api", release: config.APP_RELEASE };
}
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

async function readinessHandler(_request: FastifyRequest, reply: FastifyReply) {
  await db.query("SELECT 1");
  const redisReady = (await redis.ping()) === "PONG";
  const runtime = await getWorkerRuntime();
  const releasesMatch = workerReleaseMatches(config.APP_RELEASE, runtime);
  const ready = redisReady && Boolean(runtime) && releasesMatch;
  return reply.code(ready ? 200 : 503).send({
    status: ready ? "ready" : "not_ready",
    release: config.APP_RELEASE,
    database: true,
    redis: redisReady,
    worker: Boolean(runtime),
    workerRelease: runtime?.release ?? null,
    workerReleaseMatches: releasesMatch,
  });
}
app.get("/ready", readinessHandler);
app.get("/api/ready", readinessHandler);

app.get("/api/auth/csrf", async (_request, reply) => ({
  csrfToken: issueCsrf(reply),
}));

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});
app.post(
  "/api/auth/login",
  {
    preHandler: [requireCsrf],
    config: { rateLimit: { max: 8, timeWindow: "15 minutes" } },
  },
  async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_INPUT" });
    const email = parsed.data.email.toLowerCase();
    const result = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    const user = result.rows[0];
    if (
      !user ||
      user.status !== "active" ||
      (user.locked_until && new Date(user.locked_until) > new Date())
    ) {
      return reply
        .code(401)
        .send({ error: "INVALID_CREDENTIALS", message: "账号或密码错误" });
    }
    const valid = await verifyPassword(
      user.password_hash,
      parsed.data.password,
    );
    if (!valid) {
      await db.query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
       locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
       WHERE id = $1`,
        [user.id],
      );
      return reply
        .code(401)
        .send({ error: "INVALID_CREDENTIALS", message: "账号或密码错误" });
    }
    await db.query(
      "UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1",
      [user.id],
    );
    await createSession(user.id, reply);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.display_name,
        role: user.role,
        mustChangePassword: user.must_change_password,
      },
    };
  },
);

app.get("/api/auth/me", { preHandler: [authenticate] }, async (request) => ({
  user: request.sessionUser,
}));

app.post(
  "/api/auth/logout",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  },
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128),
});
app.post(
  "/api/auth/change-password",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "INVALID_PASSWORD", message: "新密码至少 12 位" });
    const result = await db.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [request.sessionUser!.id],
    );
    const valid = await verifyPassword(
      result.rows[0].password_hash,
      parsed.data.currentPassword,
    );
    if (!valid) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    const passwordHash = await hash(parsed.data.newPassword, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    await db.query(
      "UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2",
      [passwordHash, request.sessionUser!.id],
    );
    await destroySession(request, reply);
    await db.query("DELETE FROM sessions WHERE user_id = $1", [
      request.sessionUser!.id,
    ]);
    await createSession(request.sessionUser!.id, reply);
    return { ok: true };
  },
);

const extensionTokenSchema = z.object({
  name: z.string().trim().min(2).max(80).default("多平台草稿助手"),
});

app.get(
  "/api/extension-tokens",
  { preHandler: [authenticate] },
  async (request) => {
    const result = await db.query(
      `SELECT id, name, last_used_at, expires_at, revoked_at, created_at
       FROM extension_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [request.sessionUser!.id],
    );
    return {
      tokens: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      })),
    };
  },
);

app.post(
  "/api/extension-tokens",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const parsed = extensionTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_EXTENSION_TOKEN" });
    const activeTokenCount = await db.query(
      `SELECT COUNT(*)::int AS count FROM extension_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [request.sessionUser!.id],
    );
    if (activeTokenCount.rows[0].count >= 5)
      return reply.code(409).send({
        error: "EXTENSION_TOKEN_LIMIT",
        message: "已启用的电脑数量达到上限，请先在渠道管理停用不用的电脑。",
      });
    const id = randomUUID();
    const token = `gdxhs_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000);
    await db.query(
      `INSERT INTO extension_tokens (id, user_id, token_hash, name, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        request.sessionUser!.id,
        hashExtensionToken(token),
        parsed.data.name,
        expiresAt,
      ],
    );
    await db.query(
      "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result) VALUES ($1, $2, 'extension_token.create', 'extension_token', $3, 'success')",
      [randomUUID(), request.sessionUser!.id, id],
    );
    return reply.code(201).send({
      token: { id, name: parsed.data.name, token, expiresAt },
      warning: "连接信息已生成，页面会自动完成电脑授权。",
    });
  },
);

app.delete(
  "/api/extension-tokens/:tokenId",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ tokenId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_TOKEN_ID" });
    const client = await db.connect();
    const affectedBatches = new Set<string>();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE extension_tokens SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE id = $1 AND user_id = $2 RETURNING id`,
        [params.data.tokenId, request.sessionUser!.id],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      await client.query(
        `UPDATE browser_channel_accounts SET status = 'disabled', updated_at = NOW()
         WHERE extension_token_id = $1`,
        [params.data.tokenId],
      );
      const cancelled = await client.query(
        `UPDATE browser_delivery_items i SET status = 'cancelled',
           error_code = 'EXTENSION_TOKEN_REVOKED', updated_at = NOW()
         FROM browser_channel_accounts a
         WHERE i.account_id = a.id AND a.extension_token_id = $1
           AND i.status = 'waiting_for_extension'
         RETURNING i.batch_id`,
        [params.data.tokenId],
      );
      for (const item of cancelled.rows)
        affectedBatches.add(String(item.batch_id));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    for (const batchId of affectedBatches)
      await recomputeDeliveryBatch(batchId);
    return { ok: true };
  },
);

async function recomputeContentJobStatus(contentJobId: string) {
  const result = await db.query(
    "SELECT status FROM job_targets WHERE job_id = $1",
    [contentJobId],
  );
  const statuses = result.rows.map((row) => String(row.status));
  if (!statuses.length) return;
  const { status, message } = summarizeContentJobTargets(statuses);
  await db.query(
    `UPDATE content_jobs SET status = $1, progress = $2::jsonb, updated_at = NOW()
     WHERE id = $3 AND status <> 'cancelled'`,
    [
      status,
      JSON.stringify({ stage: status, percent: 100, message }),
      contentJobId,
    ],
  );
  await db.query(
    `UPDATE automation_schedule_runs
     SET status = $1,
         error_code = CASE WHEN $1 = 'failed' THEN COALESCE(error_code, 'CONTENT_JOB_FAILED') ELSE NULL END,
         updated_at = NOW()
     WHERE content_job_id = $2`,
    [status, contentJobId],
  );
}

function extensionTaskView(row: Record<string, any>) {
  return {
    id: row.id,
    operationId: row.operation_id,
    contentJobId: row.content_job_id,
    artifactVersion: row.artifact_version,
    contentFingerprint: row.content_fingerprint,
    channel: row.channel,
    payload: row.payload,
    status: row.status,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get(
  "/api/extensions/:channel/status",
  { preHandler: [authenticateExtension] },
  async (request, reply) => {
    const params = z
      .object({ channel: browserDraftChannelSchema })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(404).send({ error: "UNSUPPORTED_EXTENSION_CHANNEL" });
    return {
      ok: true,
      channel: params.data.channel,
      channelName: channelLabels[params.data.channel],
      user: {
        id: request.extensionAuth!.user.id,
        name: request.extensionAuth!.user.name,
      },
      capabilities: {
        uploadImages: true,
        fillArticle: true,
        saveDraft: true,
        formalPublish: false,
      },
    };
  },
);

app.post(
  "/api/extensions/:channel/tasks/claim",
  { preHandler: [authenticateExtension] },
  async (request, reply) => {
    const parsed = z
      .object({
        channel: browserDraftChannelSchema,
        taskId: z.string().uuid(),
      })
      .safeParse({
        ...(request.params as object),
        ...(request.body as object),
      });
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_CLAIM_REQUEST" });
    const tokenId = request.extensionAuth!.tokenId;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query(
        `UPDATE xiaohongshu_upload_tasks
         SET status = 'ambiguous', error_code = 'UPLOAD_CLAIM_EXPIRED',
             claim_expires_at = NULL, updated_at = NOW()
         WHERE status = 'uploading' AND claim_expires_at < NOW()
         RETURNING target_id, content_job_id`,
      );
      for (const item of expired.rows)
        await client.query(
          `UPDATE job_targets SET status = 'ambiguous', error_code = 'UPLOAD_CLAIM_EXPIRED', updated_at = NOW()
           WHERE id = $1`,
          [item.target_id],
        );
      const result = await client.query(
        `SELECT * FROM xiaohongshu_upload_tasks
         WHERE status = 'waiting_for_uploader'
           AND id = $1 AND channel = $2
           AND ($3::text = 'admin' OR created_by = $4)
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [
          parsed.data.taskId,
          parsed.data.channel,
          request.extensionAuth!.user.role,
          request.extensionAuth!.user.id,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        for (const contentJobId of new Set(
          expired.rows.map((item) => String(item.content_job_id)),
        ))
          await recomputeContentJobStatus(contentJobId);
        return { task: null };
      }
      const claimed = await client.query(
        `UPDATE xiaohongshu_upload_tasks
         SET status = 'uploading', claimed_by_token_id = $1,
             claim_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [tokenId, row.id],
      );
      await client.query(
        "UPDATE job_targets SET status = 'uploading', updated_at = NOW() WHERE id = $1",
        [row.target_id],
      );
      await client.query("COMMIT");
      for (const contentJobId of new Set(
        expired.rows.map((item) => String(item.content_job_id)),
      ))
        await recomputeContentJobStatus(contentJobId);
      return { task: extensionTaskView(claimed.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

app.post(
  "/api/extensions/:channel/tasks/:taskId/heartbeat",
  { preHandler: [authenticateExtension] },
  async (request, reply) => {
    const params = z
      .object({ channel: browserDraftChannelSchema, taskId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_TASK_ID" });
    const result = await db.query(
      `UPDATE xiaohongshu_upload_tasks
       SET claim_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
       WHERE id = $1 AND channel = $2 AND claimed_by_token_id = $3 AND status = 'uploading'
         AND claim_expires_at >= NOW()
       RETURNING id`,
      [params.data.taskId, params.data.channel, request.extensionAuth!.tokenId],
    );
    if (!result.rowCount)
      return reply.code(409).send({ error: "TASK_CLAIM_LOST" });
    return { ok: true };
  },
);

app.get(
  "/api/extensions/:channel/tasks/:taskId/images/:imageIndex",
  { preHandler: [authenticateExtension] },
  async (request, reply) => {
    const params = z
      .object({
        channel: browserDraftChannelSchema,
        taskId: z.string().uuid(),
        imageIndex: z.coerce.number().int().min(0).max(19),
      })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_IMAGE_REQUEST" });
    const result = await db.query(
      `SELECT payload FROM xiaohongshu_upload_tasks
       WHERE id = $1 AND channel = $2 AND claimed_by_token_id = $3 AND status = 'uploading'
         AND claim_expires_at >= NOW()`,
      [params.data.taskId, params.data.channel, request.extensionAuth!.tokenId],
    );
    const image = result.rows[0]?.payload?.images?.[params.data.imageIndex];
    if (!image || typeof image.url !== "string")
      return reply.code(404).send({ error: "TASK_IMAGE_NOT_FOUND" });
    let source: URL;
    try {
      source = new URL(image.url);
    } catch {
      return reply.code(404).send({ error: "TASK_IMAGE_NOT_FOUND" });
    }
    if (source.protocol !== "https:")
      return reply.code(400).send({ error: "TASK_IMAGE_URL_UNSAFE" });
    const allowedHosts = config.XIAOHONGSHU_IMAGE_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    try {
      const downloaded = await downloadRemoteImage(image.url, allowedHosts);
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type(downloaded.mime)
        .send(Buffer.from(downloaded.buffer));
    } catch {
      return reply.code(502).send({
        error: "TASK_IMAGE_DOWNLOAD_FAILED",
        message: "运营中心无法读取该配图，请在复核页替换后重试",
      });
    }
  },
);

const extensionResultSchema = z
  .object({
    status: z.enum([
      "filled",
      "drafted",
      "failed",
      "ambiguous",
      "manual_review",
    ]),
    errorCode: z.string().trim().max(120).optional(),
    message: z.string().trim().max(1_000).optional(),
    platformDraftId: z.string().trim().max(300).optional(),
    platformUrl: z.string().url().max(2_048).optional(),
    draftSaved: z.boolean().optional(),
    saveSignal: z.string().trim().max(300).optional(),
    topicsSelected: z.array(z.string().trim().max(20)).max(12).optional(),
    topicsFailed: z.array(z.string().trim().max(20)).max(12).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.status === "drafted" &&
      (value.draftSaved !== true || !value.saveSignal)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "缺少明确的草稿保存成功信号",
      });
  });

app.post(
  "/api/extensions/:channel/tasks/:taskId/result",
  { preHandler: [authenticateExtension] },
  async (request, reply) => {
    const params = z
      .object({ channel: browserDraftChannelSchema, taskId: z.string().uuid() })
      .safeParse(request.params);
    const parsed = extensionResultSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: "INVALID_TASK_RESULT" });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query(
        `SELECT * FROM xiaohongshu_upload_tasks
         WHERE id = $1 AND channel = $2 FOR UPDATE`,
        [params.data.taskId, params.data.channel],
      );
      const row = task.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      if (
        row.status === "uploading" &&
        (!row.claim_expires_at || new Date(row.claim_expires_at) < new Date())
      ) {
        await client.query(
          `UPDATE xiaohongshu_upload_tasks SET status = 'ambiguous',
           error_code = 'UPLOAD_CLAIM_EXPIRED', claim_expires_at = NULL,
           updated_at = NOW() WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `UPDATE job_targets SET status = 'ambiguous',
           error_code = 'UPLOAD_CLAIM_EXPIRED', updated_at = NOW() WHERE id = $1`,
          [row.target_id],
        );
        await client.query("COMMIT");
        await recomputeContentJobStatus(row.content_job_id);
        return reply.code(409).send({ error: "TASK_CLAIM_EXPIRED" });
      }
      if (
        row.claimed_by_token_id !== request.extensionAuth!.tokenId ||
        row.status !== "uploading"
      ) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "TASK_CLAIM_LOST" });
      }
      await client.query(
        `UPDATE xiaohongshu_upload_tasks SET status = $1, result = $2::jsonb,
         error_code = $3, claim_expires_at = NULL, updated_at = NOW() WHERE id = $4`,
        [
          parsed.data.status,
          JSON.stringify(parsed.data),
          parsed.data.errorCode ?? null,
          row.id,
        ],
      );
      await client.query(
        `UPDATE job_targets SET status = $1, error_code = $2,
         external_draft_id = COALESCE($3, external_draft_id),
         external_url = COALESCE($4, external_url), updated_at = NOW()
         WHERE id = $5`,
        [
          parsed.data.status,
          parsed.data.errorCode ?? null,
          parsed.data.platformDraftId ?? null,
          parsed.data.platformUrl ?? null,
          row.target_id,
        ],
      );
      await client.query("COMMIT");
      await recomputeContentJobStatus(row.content_job_id);
      return { ok: true, status: parsed.data.status };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);

app.get(
  "/api/manual-reviews",
  { preHandler: [authenticate] },
  async (request, reply) => {
    const parsed = z
      .object({ status: z.enum(["pending", "resolved"]).default("pending") })
      .safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_REVIEW_FILTER" });
    await ensurePendingManualReviews();
    const statusClause =
      parsed.data.status === "pending"
        ? "mr.status = 'pending'"
        : "mr.status <> 'pending'";
    const result = await db.query(
      `${reviewSelect} WHERE ${statusClause}
       ORDER BY COALESCE(mr.resolved_at, mr.created_at) DESC
       LIMIT 200`,
    );
    return { reviews: result.rows.map(manualReviewView) };
  },
);

app.post(
  "/api/manual-reviews/:reviewId/preview",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ reviewId: z.string().uuid() })
      .safeParse(request.params);
    const revision = manualReviewRevisionSchema.safeParse(request.body);
    if (!params.success || !revision.success)
      return reply.code(400).send({
        error: "INVALID_REVIEW_PREVIEW",
        message: "预览内容格式不完整，请检查文章字段和图片选择",
      });
    const client = await db.connect();
    try {
      const selected = await client.query(`${reviewSelect} WHERE mr.id = $1`, [
        params.data.reviewId,
      ]);
      const row = selected.rows[0];
      if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
      const images = await resolveReviewedImages(
        client,
        row,
        revision.data.images,
        request.sessionUser!,
      );
      const cover = revision.data.cover
        ? (
            await resolveReviewedImages(
              client,
              row,
              [revision.data.cover],
              request.sessionUser!,
              false,
            )
          )[0]
        : undefined;
      const result = applyManualReviewRevision({
        result: row.result,
        target: row.target,
        article: revision.data.article,
        images,
        cover,
        request: row.input ?? {},
      });
      const artifact = result.channelArtifacts?.[row.target];
      return {
        html: artifact?.html,
        coverUrl: cover?.url ?? images[0]?.url,
        target: row.target,
      };
    } catch (error) {
      return reply.code(409).send({
        error: "REVIEW_PREVIEW_FAILED",
        message: error instanceof Error ? error.message : "预览生成失败",
      });
    } finally {
      client.release();
    }
  },
);

app.post(
  "/api/manual-reviews/:reviewId/decision",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ reviewId: z.string().uuid() })
      .safeParse(request.params);
    const parsed = manualReviewDecisionSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({
        error: "INVALID_REVIEW_DECISION",
        message: "复核内容格式不完整，请检查文章和图片选择",
        details: parsed.success
          ? undefined
          : parsed.error.flatten().fieldErrors,
      });

    const client = await db.connect();
    let queued: { jobId: string; targetId: string } | null = null;
    let recomputeJobId: string | null = null;
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `${reviewSelect} WHERE mr.id = $1 FOR UPDATE OF mr, jt, cj`,
        [params.data.reviewId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      if (
        row.status !== "pending" ||
        !["manual_review", "ambiguous"].includes(row.target_status)
      ) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "REVIEW_ALREADY_RESOLVED",
          message: "该复核已由其他成员处理，请刷新页面查看最新结果",
        });
      }
      if (!reviewDecisionAllowed(row.category, parsed.data.decision)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "DECISION_NOT_ALLOWED",
          message: "该操作与当前复核类型不匹配",
        });
      }

      const actorId = request.sessionUser!.id;
      const decision = parsed.data.decision;
      if (decision === "approve_content") {
        if (!parsed.data.artifactRevision) {
          await client.query("ROLLBACK");
          return reply.code(400).send({
            error: "REVIEW_REVISION_REQUIRED",
            message: "请先复核文章内容，再提交通过",
          });
        }
        let result: Record<string, any>;
        try {
          const images = await resolveReviewedImages(
            client,
            row,
            parsed.data.artifactRevision.images,
            request.sessionUser!,
          );
          const cover = parsed.data.artifactRevision.cover
            ? (
                await resolveReviewedImages(
                  client,
                  row,
                  [parsed.data.artifactRevision.cover],
                  request.sessionUser!,
                  false,
                )
              )[0]
            : undefined;
          result = applyManualReviewRevision({
            result: row.result,
            target: row.target,
            article: parsed.data.artifactRevision.article,
            images,
            cover,
            request: row.input ?? {},
          });
        } catch (error) {
          await client.query("ROLLBACK");
          const code = error instanceof Error ? error.message : "";
          const messages: Record<string, string> = {
            REVIEW_ARTIFACT_MISSING: "渠道文章数据缺失，无法进入复核",
            REVIEW_IMAGE_DUPLICATED: "同一张图片不能重复使用",
            REVIEW_EXISTING_IMAGE_INVALID: "原配图已变化，请刷新页面重试",
            REVIEW_ASSET_UNAVAILABLE: "所选图片不可用或无权访问",
            ASSET_PUBLIC_SECRET_MISSING: "公开素材地址尚未配置，无法补图",
          };
          return reply.code(409).send({
            error: code || "REVIEW_REVISION_INVALID",
            message:
              messages[code] ||
              (error instanceof Error
                ? error.message
                : "复核后的文章未通过渠道格式校验"),
          });
        }
        if (!reviewedArtifactIsUsable(result, row.target)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: "REVIEW_ARTIFACT_INCOMPLETE",
            message: "复核后的渠道内容或排版不完整，不能创建草稿",
          });
        }
        await client.query(
          `UPDATE content_jobs SET result = $1::jsonb, status = 'queued',
           progress = $2::jsonb, error_code = NULL, updated_at = NOW() WHERE id = $3`,
          [
            JSON.stringify(result),
            JSON.stringify({
              stage: "queued",
              percent: 90,
              message: `人工复核已通过，正在创建${channelLabels[row.target as keyof typeof channelLabels] || row.target}草稿`,
            }),
            row.content_job_id,
          ],
        );
        await client.query(
          "UPDATE job_targets SET status = 'queued', error_code = NULL, updated_at = NOW() WHERE id = $1",
          [row.target_id],
        );
        await client.query(
          `UPDATE manual_reviews SET status = 'approved', review_note = $1,
           artifact_revision = $2::jsonb, reviewed_by = $3,
           resolved_at = NOW(), updated_at = NOW() WHERE id = $4`,
          [
            parsed.data.note,
            JSON.stringify(parsed.data.artifactRevision),
            actorId,
            row.id,
          ],
        );
        queued = { jobId: row.content_job_id, targetId: row.target_id };
      } else if (decision === "reject_content") {
        await client.query(
          `UPDATE job_targets SET status = 'failed', error_code = 'REVIEW_REJECTED',
           updated_at = NOW() WHERE id = $1`,
          [row.target_id],
        );
        await client.query(
          `UPDATE manual_reviews SET status = 'rejected', review_note = $1,
           reviewed_by = $2, resolved_at = NOW(), updated_at = NOW() WHERE id = $3`,
          [parsed.data.note, actorId, row.id],
        );
        recomputeJobId = row.content_job_id;
      } else if (decision === "confirm_drafted") {
        await client.query(
          `UPDATE job_targets SET status = 'drafted', error_code = NULL,
           external_draft_id = COALESCE($1, external_draft_id),
           external_url = COALESCE($2, external_url),
           provider_state = provider_state || $3::jsonb, updated_at = NOW()
           WHERE id = $4`,
          [
            parsed.data.externalDraftId ?? null,
            parsed.data.externalUrl ?? null,
            JSON.stringify({
              manuallyConfirmed: true,
              manualReviewId: row.id,
              confirmedAt: new Date().toISOString(),
            }),
            row.target_id,
          ],
        );
        if (row.target === "xiaohongshu")
          await client.query(
            `UPDATE xiaohongshu_upload_tasks SET status = 'drafted', error_code = NULL,
             result = result || $1::jsonb, claim_expires_at = NULL, updated_at = NOW()
             WHERE target_id = $2`,
            [
              JSON.stringify({
                manuallyConfirmed: true,
                manualReviewId: row.id,
                note: parsed.data.note,
              }),
              row.target_id,
            ],
          );
        await client.query(
          `UPDATE manual_reviews SET status = 'confirmed_drafted', review_note = $1,
           reviewed_by = $2, external_draft_id = $3, external_url = $4,
           resolved_at = NOW(), updated_at = NOW() WHERE id = $5`,
          [
            parsed.data.note,
            actorId,
            parsed.data.externalDraftId ?? null,
            parsed.data.externalUrl ?? null,
            row.id,
          ],
        );
        recomputeJobId = row.content_job_id;
      } else {
        if (row.result?.contentStatus !== "ready") {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: "RETRY_ARTIFACT_NOT_READY",
            message: "缓存内容不完整，不能安全重试渠道写入",
          });
        }
        await client.query(
          "UPDATE job_targets SET status = 'queued', error_code = NULL, updated_at = NOW() WHERE id = $1",
          [row.target_id],
        );
        await client.query(
          `UPDATE content_jobs SET status = 'queued', progress = $1::jsonb,
           error_code = NULL, updated_at = NOW() WHERE id = $2`,
          [
            JSON.stringify({
              stage: "queued",
              percent: 90,
              message: "已确认渠道内不存在草稿，正在安全重试该渠道",
            }),
            row.content_job_id,
          ],
        );
        await client.query(
          `UPDATE manual_reviews SET status = 'retrying', review_note = $1,
           reviewed_by = $2, resolved_at = NOW(), updated_at = NOW() WHERE id = $3`,
          [parsed.data.note, actorId, row.id],
        );
        queued = { jobId: row.content_job_id, targetId: row.target_id };
      }

      await client.query(
        `INSERT INTO audit_logs
         (id, actor_id, action, resource_type, resource_id, result, metadata)
         VALUES ($1, $2, 'manual_review.resolve', 'manual_review', $3, 'success', $4::jsonb)`,
        [
          randomUUID(),
          actorId,
          row.id,
          JSON.stringify({
            decision,
            target: row.target,
            contentJobId: row.content_job_id,
            revisionApplied: Boolean(parsed.data.artifactRevision),
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (queued)
      await queueReviewedTarget(
        queued.jobId,
        params.data.reviewId,
        queued.targetId,
      );
    if (recomputeJobId) await recomputeContentJobStatus(recomputeJobId);
    return { ok: true, decision: parsed.data.decision };
  },
);

app.get("/api/dashboard", { preHandler: [authenticate] }, async (request) => {
  const user = request.sessionUser!;
  const result = await db.query(
    `SELECT
    COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today_jobs,
    COUNT(*) FILTER (WHERE status = 'drafted')::int AS drafted,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
    COUNT(*)::int AS total
    FROM content_jobs WHERE deleted_at IS NULL`,
  );
  const row = result.rows[0];
  await ensurePendingManualReviews();
  const pendingReviews = await db.query(
    "SELECT COUNT(*)::int AS count FROM manual_reviews WHERE status = 'pending'",
  );
  const automation = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE enabled)::int AS enabled,
            MAX(last_triggered_at) AS last_triggered_at
     FROM automation_schedules`,
  );
  const latestAutomationRun = await db.query(
    `SELECT ar.status, ar.scheduled_for, ar.content_job_id, s.name
     FROM automation_schedule_runs ar
     JOIN automation_schedules s ON s.id = ar.schedule_id
     ORDER BY ar.scheduled_for DESC LIMIT 1`,
  );
  const recent = await db.query(
    `SELECT cj.*, u.display_name AS created_by_name
     FROM content_jobs cj JOIN users u ON u.id = cj.created_by
     WHERE cj.deleted_at IS NULL ORDER BY cj.created_at DESC LIMIT 5`,
  );
  const runtime = await getWorkerRuntime();
  const officialIssues = contentRuntimeIssues(runtime, {
    targets: ["official_site"],
    imageMode: "geekhome",
  });
  const wechatIssues = contentRuntimeIssues(runtime, {
    targets: ["wechat"],
    imageMode: "geekhome",
  });
  const officialStatus = !runtime
    ? "not_configured"
    : officialIssues.length
      ? "degraded"
      : "live";
  const wechatStatus = !runtime
    ? "not_configured"
    : wechatIssues.length
      ? "degraded"
      : "live";
  const activeChannels = [officialStatus, wechatStatus].filter(
    (status) => status === "live",
  ).length;
  const browserContentIssues = contentRuntimeIssues(runtime, {
    targets: ["xiaohongshu"],
    imageMode: "geekhome",
  });
  const connectedBrowserExtensions = await db.query(
    `SELECT COUNT(*)::int AS count FROM extension_tokens
     WHERE revoked_at IS NULL AND expires_at > NOW() AND last_used_at IS NOT NULL`,
  );
  const browserExtensionStatus = !runtime
    ? "not_configured"
    : browserContentIssues.length ||
        connectedBrowserExtensions.rows[0].count === 0
      ? "degraded"
      : "live";
  return {
    metrics: {
      todayJobs: row.today_jobs,
      pendingReviews: pendingReviews.rows[0].count,
      enabledAutomations: automation.rows[0].enabled,
      totalAutomations: automation.rows[0].total,
      activeChannels:
        activeChannels + (browserExtensionStatus === "live" ? 5 : 0),
    },
    automation: {
      lastTriggeredAt: automation.rows[0].last_triggered_at,
      latestRun: latestAutomationRun.rows[0]
        ? {
            name: latestAutomationRun.rows[0].name,
            status: latestAutomationRun.rows[0].status,
            scheduledFor: latestAutomationRun.rows[0].scheduled_for,
            contentJobId: latestAutomationRun.rows[0].content_job_id,
          }
        : null,
    },
    recentJobs: recent.rows.map((job) => contentJobView(job, [], user)),
    channels: [
      {
        id: "official_site",
        name: "极客跳动官网",
        type: "草稿箱",
        status: officialStatus,
      },
      {
        id: "wechat",
        name: "微信公众号",
        type: "草稿箱",
        status: wechatStatus,
      },
      {
        id: "xiaohongshu",
        name: "小红书",
        type: "Chrome 扩展草稿",
        status: browserExtensionStatus,
      },
      {
        id: "zhihu",
        name: "知乎文章",
        type: "Chrome 扩展草稿",
        status: browserExtensionStatus,
      },
      {
        id: "toutiao",
        name: "今日头条",
        type: "Chrome 扩展草稿",
        status: browserExtensionStatus,
      },
      {
        id: "baijiahao",
        name: "百家号",
        type: "Chrome 扩展草稿",
        status: browserExtensionStatus,
      },
      {
        id: "linkedin",
        name: "LinkedIn",
        type: "Chrome 扩展草稿/正式发布",
        status: browserExtensionStatus,
      },
    ],
  };
});

function apiTextConfig() {
  const officialOpenAi = config.CONTENT_ENGINE_MODE === "openai";
  const apiKey = officialOpenAi
    ? config.OPENAI_API_KEY
    : (config.OPENROUTER_TEXT_API_KEY ?? config.OPENROUTER_API_KEY);
  if (!apiKey) throw new Error("TEXT_PROVIDER_NOT_CONFIGURED");
  return {
    textProvider: officialOpenAi
      ? ("openai" as const)
      : ("openrouter" as const),
    openRouterApiKey: apiKey,
    openRouterModel: officialOpenAi
      ? config.OPENAI_TEXT_MODEL
      : config.OPENROUTER_TEXT_MODEL,
    openRouterTextBaseUrl: officialOpenAi
      ? config.OPENAI_BASE_URL
      : config.OPENROUTER_TEXT_BASE_URL,
    openAiReasoningEffort: config.OPENAI_REASONING_EFFORT,
    geekHomeUrl: config.GEEKHOME_MATERIAL_MCP_URL ?? "",
    geekHomeToken: config.GEEKHOME_MATERIAL_TOKEN ?? "",
  };
}

app.get(
  "/api/content-preferences",
  { preHandler: [authenticate] },
  async (request, reply) => {
    reply.header("cache-control", "private, no-store, max-age=0");
    reply.header("pragma", "no-cache");
    return getContentPreferences(db, request.sessionUser!.id);
  },
);

app.put(
  "/api/content-preferences",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const parsed = z
      .object({ defaultRemarks: z.string().trim().min(20).max(2_000) })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_DEFAULT_REMARKS" });
    const user = request.sessionUser!;
    const stored = await saveContentPreferences(
      db,
      user.id,
      parsed.data.defaultRemarks,
    );
    reply.header("cache-control", "private, no-store, max-age=0");
    return {
      ok: true,
      ...stored,
    };
  },
);

const defaultWechatEnding = {
  about:
    "极客跳动，技术团队上百人，10年开发经验。在高端软件开发项目上经验丰富，核心团队来自阿里、腾讯、携程等，秉持工程师文化与产品基因，以结果为导向，助力企业走向成功。",
  slogan: "做全球最靠谱的技术服务团队",
  phone: "182-9280-8250",
  website: "www.geekdance.cn",
  address: "深圳市宝安区易尚创意科技大厦19楼 极客跳动",
  services: ["高端软件定制｜AI相关产品开发", "智能硬件集成｜企业数字化转型"],
  recommendations: [],
};

app.get(
  "/api/settings/wechat-ending",
  { preHandler: [authenticate] },
  async () => {
    const result = await db.query(
      "SELECT value, updated_at FROM app_settings WHERE key = 'wechat.editorial_ending.v1'",
    );
    const parsed = wechatEndingSchema.safeParse(result.rows[0]?.value);
    return {
      ending: parsed.success ? parsed.data : defaultWechatEnding,
      customized: parsed.success,
      updatedAt: result.rows[0]?.updated_at ?? null,
    };
  },
);

app.put(
  "/api/settings/wechat-ending",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    if (request.sessionUser!.role !== "admin")
      return reply.code(403).send({ error: "ADMIN_REQUIRED" });
    const parsed = wechatEndingSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_WECHAT_ENDING" });
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ('wechat.editorial_ending.v1', $1::jsonb, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(parsed.data), request.sessionUser!.id],
    );
    return { ok: true, ending: parsed.data };
  },
);

app.post(
  "/api/content-title-candidates",
  {
    preHandler: [authenticate, requireCsrf],
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  },
  async (request, reply) => {
    const parsed = z
      .object({
        topic: z.string().trim().min(2).max(300),
        targets: z.array(channelSchema).min(1).max(7),
        readerMode: z.enum(["general", "professional"]),
        remarks: z.string().trim().max(2_000).optional(),
        contentType: z.enum(["general", "case"]).default("general"),
        sourceRefs: z.array(z.string().url().max(2_000)).max(20).default([]),
        attachmentIds: z.array(z.string().uuid()).max(10).default([]),
        primaryTag: z.string().trim().max(80).optional(),
        secondaryTags: z.array(z.string().trim().max(80)).max(20).default([]),
        count: z.number().int().min(10).max(20).default(12),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const attachmentRows = parsed.data.attachmentIds.length
        ? await db.query(
            "SELECT id, created_by, metadata FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'attachment' AND status = 'ready'",
            [parsed.data.attachmentIds],
          )
        : { rows: [] as Array<Record<string, any>> };
      const user = request.sessionUser!;
      const allowedAttachments = attachmentRows.rows.filter(
        (row) => user.role === "admin" || row.created_by === user.id,
      );
      if (allowedAttachments.length !== parsed.data.attachmentIds.length)
        return reply.code(400).send({ error: "ATTACHMENT_UNAVAILABLE" });
      const titles = await generateTitleCandidates(apiTextConfig(), {
        ...parsed.data,
        attachmentSummaries: allowedAttachments.map((row) => ({
          name: String(row.metadata?.originalName ?? "附件"),
          text: String(row.metadata?.extractedText ?? "").slice(0, 16_000),
        })),
      });
      if (titles.length < 10)
        return reply.code(502).send({ error: "TITLE_CANDIDATES_INCOMPLETE" });
      return { titles };
    } catch (error) {
      request.log.error({ err: error }, "title candidate generation failed");
      return reply.code(502).send({
        error: "TITLE_CANDIDATES_FAILED",
        message: "候选标题暂时生成失败，请稍后重试或直接填写标题",
      });
    }
  },
);

app.post(
  "/api/content-jobs",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const parsed = contentJobRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "INVALID_INPUT",
        details: parsed.error.flatten().fieldErrors,
      });
    const user = request.sessionUser!;
    if (parsed.data.targets.includes("wechat")) {
      const endingResult = await db.query(
        "SELECT value FROM app_settings WHERE key = 'wechat.editorial_ending.v1'",
      );
      const ending = wechatEndingSchema.safeParse(endingResult.rows[0]?.value);
      parsed.data.wechatEnding = ending.success
        ? ending.data
        : defaultWechatEnding;
    }
    if (!(await requireProductionContentRuntime(parsed.data, reply))) return;
    if (parsed.data.attachmentIds.length) {
      const attachments = await db.query(
        "SELECT id, created_by FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'attachment' AND status = 'ready'",
        [parsed.data.attachmentIds],
      );
      const allowed = attachments.rows.filter(
        (row) => user.role === "admin" || row.created_by === user.id,
      );
      if (allowed.length !== parsed.data.attachmentIds.length)
        return reply.code(400).send({ error: "ATTACHMENT_UNAVAILABLE" });
    }
    const coverAssetIds = Object.values(parsed.data.coverAssetIds ?? {});
    if (coverAssetIds.length) {
      const covers = await db.query(
        "SELECT id, created_by FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'image' AND status = 'ready'",
        [coverAssetIds],
      );
      const allowed = covers.rows.filter(
        (row) => user.role === "admin" || row.created_by === user.id,
      );
      if (allowed.length !== new Set(coverAssetIds).size)
        return reply.code(400).send({ error: "COVER_ASSET_UNAVAILABLE" });
    }
    const existing = await db.query(
      "SELECT * FROM content_jobs WHERE operation_id = $1",
      [parsed.data.operationId],
    );
    if (existing.rowCount) {
      if (existing.rows[0].created_by !== user.id && user.role !== "admin")
        return reply.code(409).send({ error: "OPERATION_ID_CONFLICT" });
      if (existing.rows[0].deleted_at)
        return reply.code(409).send({ error: "OPERATION_ID_TRASHED" });
      const targets = await db.query(
        "SELECT * FROM job_targets WHERE job_id = $1 ORDER BY target",
        [existing.rows[0].id],
      );
      return reply.send({
        job: contentJobView(existing.rows[0], targets.rows, user),
        idempotentReplay: true,
      });
    }
    const id = randomUUID();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [user.id],
      );
      const concurrentExisting = await client.query(
        "SELECT * FROM content_jobs WHERE operation_id = $1",
        [parsed.data.operationId],
      );
      if (concurrentExisting.rowCount) {
        const existingRow = concurrentExisting.rows[0];
        if (existingRow.created_by !== user.id && user.role !== "admin") {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "OPERATION_ID_CONFLICT" });
        }
        if (existingRow.deleted_at) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "OPERATION_ID_TRASHED" });
        }
        const existingTargets = await client.query(
          "SELECT * FROM job_targets WHERE job_id = $1 ORDER BY target",
          [existingRow.id],
        );
        await client.query("COMMIT");
        return reply.send({
          job: contentJobView(existingRow, existingTargets.rows, user),
          idempotentReplay: true,
        });
      }
      const active = await client.query(
        "SELECT COUNT(*)::int AS count FROM content_jobs WHERE created_by = $1 AND deleted_at IS NULL AND status = ANY($2::text[])",
        [user.id, contentGenerationActiveStatuses],
      );
      if (active.rows[0].count >= 3) {
        await client.query("ROLLBACK");
        return reply.code(429).send({
          error: "ACTIVE_JOB_LIMIT",
          message: "每名成员最多同时运行 3 个内容任务",
        });
      }
      await client.query(
        `INSERT INTO content_jobs (id, operation_id, created_by, topic, title, reader_mode, image_mode, status, input)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb)`,
        [
          id,
          parsed.data.operationId,
          user.id,
          parsed.data.topic,
          parsed.data.title ?? null,
          parsed.data.readerMode,
          parsed.data.imageMode,
          JSON.stringify(parsed.data),
        ],
      );
      for (const target of parsed.data.targets) {
        await client.query(
          "INSERT INTO job_targets (id, job_id, target, status) VALUES ($1, $2, $3, 'queued')",
          [randomUUID(), id, target],
        );
      }
      await client.query(
        "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'content_job.create', 'content_job', $3, 'accepted', $4::jsonb)",
        [
          randomUUID(),
          user.id,
          id,
          JSON.stringify({
            targets: parsed.data.targets,
            imageMode: parsed.data.imageMode,
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    try {
      await contentQueue.add(
        "run-content-pipeline",
        { contentJobId: id },
        { jobId: id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
      );
    } catch (error) {
      await db.query(
        "UPDATE content_jobs SET status = 'failed', error_code = 'QUEUE_SUBMIT_FAILED', progress = $1::jsonb, updated_at = NOW() WHERE id = $2",
        [
          JSON.stringify({
            stage: "failed",
            percent: 0,
            message: "任务队列暂时不可用",
          }),
          id,
        ],
      );
      throw error;
    }
    const created = await db.query("SELECT * FROM content_jobs WHERE id = $1", [
      id,
    ]);
    const targets = await db.query(
      "SELECT * FROM job_targets WHERE job_id = $1 ORDER BY target",
      [id],
    );
    return reply
      .code(202)
      .send({ job: contentJobView(created.rows[0], targets.rows, user) });
  },
);

app.get(
  "/api/content-jobs",
  { preHandler: [authenticate] },
  async (request, reply) => {
    const user = request.sessionUser!;
    const parsed = z
      .object({ view: z.enum(["active", "trash"]).default("active") })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_VIEW" });
    const deletedFilter =
      parsed.data.view === "trash"
        ? "cj.deleted_at IS NOT NULL"
        : "cj.deleted_at IS NULL";
    const result = await db.query(
      `SELECT cj.*, u.display_name AS created_by_name
       FROM content_jobs cj JOIN users u ON u.id = cj.created_by
       WHERE ${deletedFilter}
       ORDER BY COALESCE(cj.deleted_at, cj.created_at) DESC LIMIT 100`,
    );
    return {
      jobs: result.rows.map((row) => contentJobView(row, [], user)),
    };
  },
);

app.get(
  "/api/content-jobs/:jobId/image-suggestions",
  {
    preHandler: [authenticate],
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const result = await db.query(
      "SELECT input, result FROM content_jobs WHERE id = $1 AND deleted_at IS NULL",
      [params.data.jobId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      const input = contentJobRequestSchema.parse(result.rows[0].input);
      const usedUrls = new Set(
        Object.values(result.rows[0].result?.channelArtifacts ?? {}).flatMap(
          (artifact: any) =>
            Array.isArray(artifact?.assets)
              ? artifact.assets.flatMap((asset: any) =>
                  typeof asset?.selected?.url === "string"
                    ? [asset.selected.url]
                    : [],
                )
              : [],
        ),
      );
      const generatedResult = await db.query(
        `SELECT id, source, metadata, created_at
         FROM assets
         WHERE kind = 'image' AND status = 'ready'
           AND metadata->>'contentJobId' = $1
           AND COALESCE(metadata->>'role', '') IN ('cover', 'inline')
         ORDER BY created_at ASC
         LIMIT 16`,
        [params.data.jobId],
      );
      const generated = config.ASSET_PUBLIC_SECRET
        ? generatedResult.rows.map((asset) => {
            const signature = createHmac("sha256", config.ASSET_PUBLIC_SECRET!)
              .update(asset.id)
              .digest("hex");
            const role = asset.metadata?.role === "cover" ? "cover" : "inline";
            const chapterHeading =
              typeof asset.metadata?.chapterHeading === "string"
                ? asset.metadata.chapterHeading
                : undefined;
            return {
              source: "generated" as const,
              assetId: asset.id as string,
              materialId: asset.id as string,
              title:
                role === "cover"
                  ? "AI 生成封面候选"
                  : `AI 章节插图：${chapterHeading ?? "正文配图"}`,
              url: `${config.APP_ORIGIN.replace(/\/$/, "")}/api/public/assets/${asset.id}/${signature}`,
              description:
                role === "cover"
                  ? "根据全文主题生成的品牌封面候选"
                  : `根据章节“${chapterHeading ?? "正文"}”内容生成`,
              role,
              chapterHeading,
              usageCount: 0,
              copyright: "AI 生成素材；插入前请确认画面与文章语义一致。",
            };
          })
        : [];
      let materialWarning: string | undefined;
      const materials =
        input.includeGeekHome &&
        config.GEEKHOME_MATERIAL_MCP_URL &&
        config.GEEKHOME_MATERIAL_TOKEN
          ? await searchGeekHomeMaterials(
              {
                geekHomeUrl: config.GEEKHOME_MATERIAL_MCP_URL,
                geekHomeToken: config.GEEKHOME_MATERIAL_TOKEN,
              },
              input,
            ).catch((error) => {
              request.log.warn(
                { err: error },
                "GeekHome suggestion search failed; generated candidates remain available",
              );
              materialWarning =
                "GeekHome 素材本次未能读取，AI 章节插图仍可正常选用";
              return [];
            })
          : [];
      const geekHome = materials
        .filter((item) => item.url && !usedUrls.has(item.url))
        .filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.url === item.url) ===
            index,
        )
        .slice(0, 16)
        .map((item) => ({
          source: "geekhome" as const,
          materialId: item.id ?? item.url,
          title: item.title,
          url: item.url,
          description: item.description,
          primaryTag: item.primaryTag,
          secondaryTags: item.secondaryTags ?? [],
          usageCount: item.usageCount ?? 0,
          copyright:
            "GeekHome 内部授权素材；插入草稿前仍需运营人员确认人物与客户现场授权。",
        }));
      return {
        suggestions: [...generated, ...geekHome],
        warning:
          materialWarning ??
          (!input.includeGeekHome
            ? "本任务未启用 GeekHome；当前仅展示 AI 章节结构插图和上传图片"
            : undefined),
        generation: result.rows[0].result?.imageSuggestionGeneration ?? null,
      };
    } catch (error) {
      request.log.error({ err: error }, "image suggestion search failed");
      return reply.code(502).send({
        error: "IMAGE_SUGGESTIONS_FAILED",
        message: "相关图片抓取失败，请稍后重试",
      });
    }
  },
);

app.post(
  "/api/content-jobs/:jobId/image-suggestions/generate",
  {
    preHandler: [authenticate, requireCsrf],
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
  },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const runtimeRequest = {
      targets: [] as Channel[],
      imageMode: "generated" as const,
    };
    if (!(await requireProductionContentRuntime(runtimeRequest, reply))) return;

    const client = await db.connect();
    let queuedState: Record<string, unknown> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`content-image-candidates:${params.data.jobId}`],
      );
      const jobResult = await client.query(
        `SELECT id, input, result, deleted_at
         FROM content_jobs WHERE id = $1`,
        [params.data.jobId],
      );
      if (!jobResult.rowCount || jobResult.rows[0].deleted_at) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      const row = jobResult.rows[0];
      const input = contentJobRequestSchema.safeParse(row.input);
      if (!input.success || !row.result?.article) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "ARTICLE_NOT_READY",
          message: "文章尚未生成完成，暂时不能生成章节插图",
        });
      }
      const currentGeneration = row.result?.imageSuggestionGeneration;
      if (["queued", "running"].includes(currentGeneration?.status)) {
        await client.query("COMMIT");
        return reply.code(202).send({
          accepted: true,
          generation: currentGeneration,
          idempotentReplay: true,
        });
      }
      const existing = await client.query(
        `SELECT COUNT(*)::int AS count FROM assets
         WHERE kind = 'image' AND status = 'ready'
           AND metadata->>'contentJobId' = $1
           AND COALESCE(metadata->>'role', '') IN ('cover', 'inline')`,
        [params.data.jobId],
      );
      if (existing.rows[0].count > 0) {
        await client.query("COMMIT");
        return reply.code(409).send({
          error: "IMAGE_CANDIDATES_ALREADY_EXIST",
          message: `本任务已有 ${existing.rows[0].count} 张 AI 候选图，无需重复生成`,
        });
      }
      queuedState = {
        status: "queued",
        completed: 0,
        total: 0,
        message: "已提交生成任务，正在等待图片引擎",
        queuedAt: new Date().toISOString(),
      };
      await client.query(
        `UPDATE content_jobs
         SET result = jsonb_set(COALESCE(result, '{}'::jsonb), '{imageSuggestionGeneration}', $1::jsonb, true),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(queuedState), params.data.jobId],
      );
      await client.query(
        `INSERT INTO audit_logs
         (id, actor_id, action, resource_type, resource_id, result, metadata)
         VALUES ($1, $2, 'content_job.image_candidates.generate', 'content_job', $3, 'accepted', $4::jsonb)`,
        [
          randomUUID(),
          request.sessionUser!.id,
          params.data.jobId,
          JSON.stringify({ targets: input.data.targets }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    try {
      await contentQueue.add(
        "generate-content-image-candidates",
        { contentJobId: params.data.jobId },
        {
          jobId: `image-candidates-${params.data.jobId}-${Date.now()}`,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      request.log.error({ err: error }, "image candidate queue submit failed");
      const failedState = {
        status: "failed",
        completed: 0,
        total: 0,
        errorCode: "IMAGE_CANDIDATE_QUEUE_FAILED",
        message: "插图生成任务提交失败，请稍后重试",
        failedAt: new Date().toISOString(),
      };
      await db.query(
        `UPDATE content_jobs
         SET result = jsonb_set(COALESCE(result, '{}'::jsonb), '{imageSuggestionGeneration}', $1::jsonb, true),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(failedState), params.data.jobId],
      );
      return reply.code(503).send({
        error: "IMAGE_CANDIDATE_QUEUE_FAILED",
        message: failedState.message,
      });
    }
    return reply.code(202).send({ accepted: true, generation: queuedState });
  },
);

app.get(
  "/api/content-jobs/:jobId/image-suggestions/generation",
  {
    preHandler: [authenticate],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const result = await db.query(
      `SELECT result->'imageSuggestionGeneration' AS generation
       FROM content_jobs
       WHERE id = $1 AND deleted_at IS NULL`,
      [params.data.jobId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    return { generation: result.rows[0].generation ?? null };
  },
);

async function ownedContentJob(
  jobId: string,
  user: NonNullable<FastifyRequest["sessionUser"]>,
) {
  const result = await db.query("SELECT * FROM content_jobs WHERE id = $1", [
    jobId,
  ]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (user.role !== "admin" && row.created_by !== user.id) return null;
  return row;
}

app.post(
  "/api/content-jobs/:jobId/trash",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const row = await ownedContentJob(params.data.jobId, request.sessionUser!);
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    if (cancellableJobStatuses.includes(row.status))
      return reply.code(409).send({
        error: "ACTIVE_JOB_NOT_DELETABLE",
        message: "运行中的任务请先取消，完成后再移入回收站",
      });
    if (!row.deleted_at) {
      await db.query(
        "UPDATE content_jobs SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW() WHERE id = $2",
        [request.sessionUser!.id, row.id],
      );
      await db.query(
        "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'content_job.trash', 'content_job', $3, 'success', $4::jsonb)",
        [
          randomUUID(),
          request.sessionUser!.id,
          row.id,
          JSON.stringify({ externalDraftsPreserved: true }),
        ],
      );
    }
    return { ok: true };
  },
);

app.post(
  "/api/content-jobs/:jobId/restore",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const row = await ownedContentJob(params.data.jobId, request.sessionUser!);
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!row.deleted_at) return { ok: true };
    await db.query(
      "UPDATE content_jobs SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW() WHERE id = $1",
      [row.id],
    );
    await db.query(
      "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result) VALUES ($1, $2, 'content_job.restore', 'content_job', $3, 'success')",
      [randomUUID(), request.sessionUser!.id, row.id],
    );
    return { ok: true };
  },
);

app.delete(
  "/api/content-jobs/:jobId",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const row = await ownedContentJob(params.data.jobId, request.sessionUser!);
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!row.deleted_at)
      return reply.code(409).send({
        error: "JOB_NOT_IN_TRASH",
        message: "任务必须先移入回收站",
      });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE automation_schedules SET last_job_id = NULL WHERE last_job_id = $1",
        [row.id],
      );
      await client.query(
        "UPDATE automation_schedule_runs SET content_job_id = NULL WHERE content_job_id = $1",
        [row.id],
      );
      await client.query("DELETE FROM content_jobs WHERE id = $1", [row.id]);
      await client.query(
        "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'content_job.delete', 'content_job', $3, 'success', $4::jsonb)",
        [
          randomUUID(),
          request.sessionUser!.id,
          row.id,
          JSON.stringify({ externalDraftsPreserved: true }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { ok: true };
  },
);

app.get(
  "/api/content-jobs/:jobId",
  { preHandler: [authenticate] },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    await ensurePendingManualReviews(params.data.jobId);
    const result = await db.query(
      `SELECT cj.*, u.display_name AS created_by_name
       FROM content_jobs cj JOIN users u ON u.id = cj.created_by
       WHERE cj.id = $1`,
      [params.data.jobId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    const row = result.rows[0];
    const targets = await db.query(
      `SELECT jt.*, xt.id AS xhs_upload_task_id, xt.status AS xhs_upload_status,
              xt.error_code AS xhs_upload_error_code, xt.updated_at AS xhs_upload_updated_at
       FROM job_targets jt
       LEFT JOIN xiaohongshu_upload_tasks xt ON xt.target_id = jt.id
       WHERE jt.job_id = $1 ORDER BY jt.target`,
      [row.id],
    );
    const reviews = await db.query(
      `${reviewSelect} WHERE mr.content_job_id = $1
       ORDER BY mr.created_at DESC`,
      [row.id],
    );
    const attachmentIds = Array.isArray(row.input?.attachmentIds)
      ? row.input.attachmentIds.filter(
          (id: unknown) => z.string().uuid().safeParse(id).success,
        )
      : [];
    const attachmentRows = attachmentIds.length
      ? await db.query(
          `SELECT id, mime_type, metadata
           FROM assets
           WHERE id = ANY($1::uuid[]) AND kind = 'attachment'`,
          [attachmentIds],
        )
      : { rows: [] as Record<string, any>[] };
    const attachmentsById = new Map(
      attachmentRows.rows.map((attachment) => [attachment.id, attachment]),
    );
    const inputAttachments = attachmentIds.flatMap((id: string) => {
      const attachment = attachmentsById.get(id);
      return attachment ? [attachment] : [];
    });
    return {
      job: contentJobView(
        row,
        targets.rows,
        request.sessionUser!,
        reviews.rows,
        inputAttachments,
      ),
    };
  },
);

app.post(
  "/api/content-jobs/:jobId/cancel",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const client = await db.connect();
    let row: Record<string, any>;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM content_jobs WHERE id = $1 FOR UPDATE",
        [params.data.jobId],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      row = result.rows[0];
      if (
        request.sessionUser!.role !== "admin" &&
        row.created_by !== request.sessionUser!.id
      ) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      if (row.deleted_at) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "JOB_IN_TRASH" });
      }
      if (!cancellableJobStatuses.includes(row.status)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "JOB_NOT_CANCELLABLE" });
      }
      const targets = await client.query(
        "SELECT target, status FROM job_targets WHERE job_id = $1 FOR UPDATE",
        [row.id],
      );
      const unsafeTarget = targets.rows.find((target) =>
        cancellationUnsafeTargetStatuses.includes(target.status),
      );
      if (row.status === "publishing" || unsafeTarget) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "EXTERNAL_WRITE_ALREADY_STARTED",
          message: "仍有渠道正在写入草稿，请等待写入结束后再取消尚未执行的渠道",
        });
      }
      const pendingTargets = targets.rows.filter((target) =>
        cancellableTargetStatuses.includes(target.status),
      );
      if (!pendingTargets.length) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "JOB_NOT_CANCELLABLE" });
      }
      await client.query(
        "UPDATE job_targets SET status = 'cancelled', error_code = 'TASK_CANCELLED', updated_at = NOW() WHERE job_id = $1 AND status = ANY($2::text[])",
        [row.id, cancellableTargetStatuses],
      );
      await client.query(
        `UPDATE xiaohongshu_upload_tasks SET status = 'failed', error_code = 'TASK_CANCELLED', updated_at = NOW()
         WHERE content_job_id = $1 AND status = 'waiting_for_uploader'`,
        [row.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await recomputeContentJobStatus(row!.id);
    const queueJob = await contentQueue.getJob(row!.id);
    if (queueJob) await queueJob.remove().catch(() => undefined);
    const updated = await db.query(
      "SELECT status, progress FROM content_jobs WHERE id = $1",
      [row!.id],
    );
    return {
      ok: true,
      status: updated.rows[0]?.status,
      message: updated.rows[0]?.progress?.message,
    };
  },
);

app.post(
  "/api/content-jobs/:jobId/retry",
  { preHandler: [authenticate, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ jobId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_JOB_ID" });
    const result = await db.query("SELECT * FROM content_jobs WHERE id = $1", [
      params.data.jobId,
    ]);
    if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    const row = result.rows[0];
    if (
      request.sessionUser!.role !== "admin" &&
      row.created_by !== request.sessionUser!.id
    )
      return reply.code(404).send({ error: "NOT_FOUND" });
    if (row.deleted_at) return reply.code(409).send({ error: "JOB_IN_TRASH" });
    const failedTargets = await db.query(
      "SELECT id, target FROM job_targets WHERE job_id = $1 AND status = 'failed' ORDER BY target",
      [row.id],
    );
    if (!failedTargets.rowCount)
      return reply.code(409).send({
        error: "NO_RETRYABLE_TARGET",
        message: "仅允许重试明确失败且结果不含歧义的渠道",
      });
    await db.query(
      "UPDATE job_targets SET status = 'queued', error_code = NULL, updated_at = NOW() WHERE job_id = $1 AND status = 'failed'",
      [row.id],
    );
    await db.query(
      "UPDATE content_jobs SET status = 'queued', progress = $1::jsonb, error_code = NULL, updated_at = NOW() WHERE id = $2",
      [
        JSON.stringify({
          stage: "queued",
          percent: 0,
          message: "明确失败的渠道已重新进入队列",
        }),
        row.id,
      ],
    );
    try {
      await contentQueue.add(
        "retry-failed-draft-targets",
        { contentJobId: row.id },
        {
          jobId: `retry-${row.id}-${Date.now()}`,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      await db.query(
        "UPDATE job_targets SET status = 'failed', error_code = 'RETRY_QUEUE_SUBMIT_FAILED', updated_at = NOW() WHERE job_id = $1 AND status = 'queued'",
        [row.id],
      );
      const drafted = await db.query(
        "SELECT COUNT(*)::int AS count FROM job_targets WHERE job_id = $1 AND status = 'drafted'",
        [row.id],
      );
      const status = drafted.rows[0].count > 0 ? "partial" : "failed";
      await db.query(
        "UPDATE content_jobs SET status = $1, error_code = 'RETRY_QUEUE_SUBMIT_FAILED', progress = $2::jsonb, updated_at = NOW() WHERE id = $3",
        [
          status,
          JSON.stringify({
            stage: status,
            percent: 100,
            message: "重试队列暂时不可用，失败渠道仍可稍后重试",
          }),
          row.id,
        ],
      );
      throw error;
    }
    return reply.code(202).send({
      accepted: true,
      jobId: row.id,
      targets: failedTargets.rows.map((target) => target.target),
    });
  },
);

app.get(
  "/api/admin/automation-schedules",
  { preHandler: [requireAdmin] },
  async () => {
    const result = await db.query(
      "SELECT * FROM automation_schedules ORDER BY created_at",
    );
    return { schedules: result.rows.map(scheduleView) };
  },
);

app.post(
  "/api/admin/automation-schedules",
  { preHandler: [requireAdmin, requireCsrf] },
  async (request, reply) => {
    const parsed = automationScheduleRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "INVALID_SCHEDULE",
        details: parsed.error.flatten().fieldErrors,
      });
    if (
      parsed.data.enabled &&
      !(await requireProductionContentRuntime(parsed.data.template, reply))
    )
      return;
    const id = randomUUID();
    const result = await db.query(
      `INSERT INTO automation_schedules (id, name, enabled, cron_expression, timezone, template, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [
        id,
        parsed.data.name,
        parsed.data.enabled,
        parsed.data.cronExpression,
        parsed.data.timezone,
        JSON.stringify(parsed.data.template),
        request.sessionUser!.id,
      ],
    );
    await syncSchedule(result.rows[0]);
    await db.query(
      "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'schedule.create', 'automation_schedule', $3, 'success', $4::jsonb)",
      [
        randomUUID(),
        request.sessionUser!.id,
        id,
        JSON.stringify({
          enabled: parsed.data.enabled,
          cronExpression: parsed.data.cronExpression,
        }),
      ],
    );
    return reply.code(201).send({ schedule: scheduleView(result.rows[0]) });
  },
);

app.patch(
  "/api/admin/automation-schedules/:scheduleId",
  { preHandler: [requireAdmin, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ scheduleId: z.string().uuid() })
      .safeParse(request.params);
    const parsed = automationScheduleRequestSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: "INVALID_SCHEDULE" });
    if (
      parsed.data.enabled &&
      !(await requireProductionContentRuntime(parsed.data.template, reply))
    )
      return;
    const result = await db.query(
      `UPDATE automation_schedules SET name = $1, enabled = $2, cron_expression = $3, timezone = $4, template = $5::jsonb, updated_at = NOW()
     WHERE id = $6 RETURNING *`,
      [
        parsed.data.name,
        parsed.data.enabled,
        parsed.data.cronExpression,
        parsed.data.timezone,
        JSON.stringify(parsed.data.template),
        params.data.scheduleId,
      ],
    );
    if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    await syncSchedule(result.rows[0]);
    await db.query(
      "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'schedule.update', 'automation_schedule', $3, 'success', $4::jsonb)",
      [
        randomUUID(),
        request.sessionUser!.id,
        params.data.scheduleId,
        JSON.stringify({
          enabled: parsed.data.enabled,
          cronExpression: parsed.data.cronExpression,
        }),
      ],
    );
    return { schedule: scheduleView(result.rows[0]) };
  },
);

app.post(
  "/api/admin/automation-schedules/:scheduleId/run",
  { preHandler: [requireAdmin, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ scheduleId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_SCHEDULE_ID" });
    const exists = await db.query(
      "SELECT id, template FROM automation_schedules WHERE id = $1",
      [params.data.scheduleId],
    );
    if (!exists.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    if (
      !(await requireProductionContentRuntime(exists.rows[0].template, reply))
    )
      return;
    const triggerId = randomUUID();
    await automationQueue.add(
      "run-content-schedule",
      {
        scheduleId: params.data.scheduleId,
        occurrenceKey: `manual:${triggerId}`,
        force: true,
      },
      {
        jobId: `manual-${triggerId}`,
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return reply.code(202).send({ accepted: true, triggerId });
  },
);

app.delete(
  "/api/admin/automation-schedules/:scheduleId",
  { preHandler: [requireAdmin, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ scheduleId: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "INVALID_SCHEDULE_ID" });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "DELETE FROM automation_schedules WHERE id = $1 RETURNING id",
        [params.data.scheduleId],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      await client.query(
        `INSERT INTO audit_logs
         (id, actor_id, action, resource_type, resource_id, result)
         VALUES ($1, $2, 'schedule.delete', 'automation_schedule', $3, 'success')`,
        [randomUUID(), request.sessionUser!.id, params.data.scheduleId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    // Delete the source of truth first. If scheduler cleanup is temporarily
    // unavailable, a stray queue tick safely skips the now-missing schedule;
    // the reverse order could leave an enabled database row with no scheduler.
    await automationQueue
      .removeJobScheduler(params.data.scheduleId)
      .catch(() => undefined);
    return { ok: true };
  },
);

app.get("/api/admin/users", { preHandler: [requireAdmin] }, async () => {
  const result = await db.query(
    'SELECT id, email, display_name AS name, role, status, must_change_password AS "mustChangePassword", created_at AS "createdAt" FROM users ORDER BY created_at DESC',
  );
  return { users: result.rows };
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  role: z.enum(["admin", "operator"]),
  temporaryPassword: z.string().min(12).max(128),
});
app.post(
  "/api/admin/users",
  { preHandler: [requireAdmin, requireCsrf] },
  async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "INVALID_INPUT" });
    const passwordHash = await hash(parsed.data.temporaryPassword, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const id = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1, $2, $3, $4, $5)",
      [
        id,
        parsed.data.email.toLowerCase(),
        parsed.data.name,
        passwordHash,
        parsed.data.role,
      ],
    );
    await db.query(
      "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'user.create', 'user', $3, 'success', $4::jsonb)",
      [
        randomUUID(),
        request.sessionUser!.id,
        id,
        JSON.stringify({ role: parsed.data.role }),
      ],
    );
    return reply.code(201).send({ id });
  },
);

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(["admin", "operator"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    temporaryPassword: z.string().min(12).max(128).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined));
app.patch(
  "/api/admin/users/:userId",
  { preHandler: [requireAdmin, requireCsrf] },
  async (request, reply) => {
    const params = z
      .object({ userId: z.string().uuid() })
      .safeParse(request.params);
    const parsed = updateUserSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: "INVALID_INPUT" });
    const existing = await db.query("SELECT * FROM users WHERE id = $1", [
      params.data.userId,
    ]);
    if (!existing.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    const user = existing.rows[0];
    const nextRole = parsed.data.role ?? user.role;
    const nextStatus = parsed.data.status ?? user.status;
    if (
      user.role === "admin" &&
      user.status === "active" &&
      (nextRole !== "admin" || nextStatus !== "active")
    ) {
      const otherAdmins = await db.query(
        "SELECT COUNT(*)::int AS count FROM users WHERE id <> $1 AND role = 'admin' AND status = 'active'",
        [user.id],
      );
      if (otherAdmins.rows[0].count < 1)
        return reply.code(409).send({
          error: "LAST_ACTIVE_ADMIN",
          message: "不能停用或降级最后一名有效管理员",
        });
    }
    const passwordHash = parsed.data.temporaryPassword
      ? await hash(parsed.data.temporaryPassword, {
          algorithm: 2,
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
        })
      : user.password_hash;
    const result = await db.query(
      `UPDATE users SET display_name = $1, role = $2, status = $3, password_hash = $4,
       must_change_password = $5, updated_at = NOW() WHERE id = $6
       RETURNING id, email, display_name AS name, role, status, must_change_password AS "mustChangePassword", created_at AS "createdAt"`,
      [
        parsed.data.name ?? user.display_name,
        nextRole,
        nextStatus,
        passwordHash,
        parsed.data.temporaryPassword ? true : user.must_change_password,
        user.id,
      ],
    );
    if (parsed.data.temporaryPassword || nextStatus === "disabled")
      await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    await db.query(
      "INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, result, metadata) VALUES ($1, $2, 'user.update', 'user', $3, 'success', $4::jsonb)",
      [
        randomUUID(),
        request.sessionUser!.id,
        user.id,
        JSON.stringify({
          role: nextRole,
          status: nextStatus,
          passwordReset: Boolean(parsed.data.temporaryPassword),
        }),
      ],
    );
    return { user: result.rows[0] };
  },
);

app.get(
  "/api/admin/channel-health",
  { preHandler: [authenticate] },
  async () => {
    const runtime = await getWorkerRuntime();
    const localStorageReady = await localAssetStorageReady();
    const textReady = Boolean(
      runtime &&
      ["openrouter", "openai"].includes(runtime.contentEngineMode) &&
      runtime.textKeyConfigured &&
      runtime.geekHomeConfigured,
    );
    const imageReady = Boolean(
      runtime &&
      ["openrouter", "openai"].includes(runtime.imageProviderMode) &&
      runtime.imageKeyConfigured,
    );
    const officialIssues = contentRuntimeIssues(runtime, {
      targets: ["official_site"],
      imageMode: "geekhome",
    });
    const wechatIssues = contentRuntimeIssues(runtime, {
      targets: ["wechat"],
      imageMode: "geekhome",
    });
    const connectedBrowserExtensions = await db.query(
      `SELECT COUNT(*)::int AS count FROM extension_tokens
       WHERE revoked_at IS NULL AND expires_at > NOW() AND last_used_at IS NOT NULL`,
    );
    const browserExtensionIssue =
      connectedBrowserExtensions.rows[0].count > 0
        ? []
        : [
            {
              code: "BROWSER_EXTENSION_NOT_CONNECTED",
              message: "尚未检测到已配对并连接过的多平台草稿助手",
            },
          ];
    const browserChannelIssues = (
      channel:
        | "xiaohongshu"
        | "zhihu"
        | "toutiao"
        | "baijiahao"
        | "linkedin",
    ) => [
      ...contentRuntimeIssues(runtime, {
        targets: [channel],
        imageMode: "geekhome",
      }),
      ...browserExtensionIssue,
    ];
    const xiaohongshuIssues = browserChannelIssues("xiaohongshu");
    const zhihuIssues = browserChannelIssues("zhihu");
    const toutiaoIssues = browserChannelIssues("toutiao");
    const baijiahaoIssues = browserChannelIssues("baijiahao");
    const linkedinIssues = browserChannelIssues("linkedin");
    const officialReady = officialIssues.length === 0;
    const wechatReady = wechatIssues.length === 0;
    return {
      workerOnline: Boolean(runtime),
      release: config.APP_RELEASE,
      workerRelease: runtime?.release ?? null,
      workerReleaseMatches: workerReleaseMatches(config.APP_RELEASE, runtime),
      recordedAt: runtime?.recordedAt ?? null,
      channels: [
        {
          id: "official_site",
          name: "极客跳动官网",
          status: officialReady
            ? "live"
            : runtime
              ? "degraded"
              : "not_configured",
          issues: officialIssues,
        },
        {
          id: "wechat",
          name: "微信公众号",
          status: wechatReady
            ? "live"
            : runtime
              ? "degraded"
              : "not_configured",
          issues: wechatIssues,
        },
        {
          id: "openrouter",
          name: "AI 模型服务",
          status: !runtime
            ? "not_configured"
            : textReady && imageReady
              ? "live"
              : "degraded",
          textModel:
            runtime?.textModel ??
            (config.CONTENT_ENGINE_MODE === "openai"
              ? config.OPENAI_TEXT_MODEL
              : config.OPENROUTER_TEXT_MODEL),
          imageModel:
            runtime?.imageModel ??
            (config.IMAGE_PROVIDER_MODE === "openai"
              ? config.OPENAI_IMAGE_MODEL
              : config.OPENROUTER_IMAGE_MODEL),
          contentMode: runtime?.contentEngineMode ?? config.CONTENT_ENGINE_MODE,
          imageMode: runtime?.imageProviderMode ?? config.IMAGE_PROVIDER_MODE,
          textReady,
          imageReady,
          issues: contentRuntimeIssues(runtime, {
            targets: [],
            imageMode: "generated",
          }),
        },
        {
          id: "oss",
          name: "素材存储",
          status: localStorageReady ? "healthy" : "degraded",
          storageMode: assetStore ? "oss_and_local" : "local_volume",
          issues: localStorageReady
            ? []
            : [
                {
                  code: "LOCAL_ASSET_STORAGE_UNAVAILABLE",
                  message: "本地素材持久卷不可读写",
                },
              ],
        },
        {
          id: "xiaohongshu",
          name: "小红书草稿",
          status: xiaohongshuIssues.length
            ? runtime
              ? "degraded"
              : "not_configured"
            : "live",
          issues: xiaohongshuIssues,
        },
        {
          id: "zhihu",
          name: "知乎文章草稿",
          status: zhihuIssues.length
            ? runtime
              ? "degraded"
              : "not_configured"
            : "live",
          issues: zhihuIssues,
        },
        {
          id: "toutiao",
          name: "今日头条草稿",
          status: toutiaoIssues.length
            ? runtime
              ? "degraded"
              : "not_configured"
            : "live",
          issues: toutiaoIssues,
        },
        {
          id: "baijiahao",
          name: "百家号草稿",
          status: baijiahaoIssues.length
            ? runtime
              ? "degraded"
              : "not_configured"
            : "live",
          issues: baijiahaoIssues,
        },
        {
          id: "linkedin",
          name: "LinkedIn",
          status: linkedinIssues.length
            ? runtime
              ? "degraded"
              : "not_configured"
            : "live",
          issues: linkedinIssues,
        },
      ],
    };
  },
);

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, requestId: request.id }, "request failed");
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    return reply.code(409).send({ error: "CONFLICT" });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return reply.code(error.statusCode).send({
      error: "BAD_REQUEST",
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "请求格式错误",
    });
  }
  return reply
    .code(500)
    .send({ error: "INTERNAL_ERROR", requestId: request.id });
});

await migrate();
await bootstrapAdmin();
await bootstrapDefaultSchedule();
await registerImageRoutes(app, imageQueue, getWorkerRuntime, assetStore);
await registerAttachmentRoutes(app);
await registerMultiAccountDeliveryRoutes(app);
for (const schedule of (await db.query("SELECT * FROM automation_schedules"))
  .rows)
  await syncSchedule(schedule);
await app.listen({ port: config.API_PORT, host: "0.0.0.0" });

async function shutdown() {
  await app.close();
  await contentQueue.close();
  await automationQueue.close();
  await imageQueue.close();
  await redis.quit();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
