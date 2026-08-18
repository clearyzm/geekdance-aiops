import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { z } from "zod";
import {
  contentRuntimeIssues,
  contentJobRequestSchema,
  coreArticleSchema,
  browserDraftChannelSchema,
  channelLabels,
  evidenceItemSchema,
  type BrowserDraftChannel,
  type JobStatus,
  type ResearchAttachment,
  type WorkerRuntimeSnapshot,
} from "@geekdance/shared";
import {
  createLivePorts,
  generateCaseDiagramSpecs,
  mockPorts,
  runContentPipeline,
  searchGeekHomeMaterials,
  type ContentPipelineProgress,
} from "@geekdance/content-engine";
import {
  createOssAssetStore,
  downloadRemoteImage,
  OfficialPublisherError,
  OfficialSitePublisher,
  WechatOfficialPublisher,
  WechatPublisherError,
  type WechatTokenRecord,
  type WechatTokenStore,
} from "@geekdance/channel-adapters";
import { createImageJobWorker } from "./image-jobs.js";
import { generateContentImages } from "./content-images.js";
import { firstNonEmpty } from "./runtime-config.js";
import { resolveXiaohongshuUploadImages } from "./xiaohongshu-upload.js";
import { verifyGeneratedImageFonts } from "./svg-renderer.js";
import {
  applyGeekDanceWechatCoverStyle,
  applyGeekDanceWebsiteCoverStyle,
  createGeekDanceWechatFallbackCover,
  shouldCreateWechatFallbackCover,
  WECHAT_COVER_CROPS,
  WECHAT_COVER_STYLE_VERSION,
} from "./wechat-cover.js";

const env = z
  .object({
    APP_RELEASE: z.string().min(1).max(128).default("local"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    REDIS_URL: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    CONTENT_QUEUE_NAME: z.string().default("content-jobs"),
    AUTOMATION_QUEUE_NAME: z.string().default("automation-jobs"),
    IMAGE_QUEUE_NAME: z.string().default("image-jobs"),
    ASSET_STORAGE_DIR: z.string().default("/data/assets"),
    OSS_ENDPOINT: z.string().url().optional(),
    OSS_BUCKET: z.string().optional(),
    OSS_PREFIX: z.string().default("ai-ops"),
    OSS_ACCESS_KEY_ID: z.string().optional(),
    OSS_ACCESS_KEY_SECRET: z.string().optional(),
    IMAGE_SERVICE_URL: z.string().url().default("http://image-worker:8000"),
    IMAGE_PROVIDER_MODE: z
      .enum(["mock", "openrouter", "openai"])
      .default("mock"),
    OPENROUTER_BASE_URL: z.string().url().optional(),
    OPENROUTER_TEXT_BASE_URL: z
      .string()
      .url()
      .default("https://openrouter.ai/api/v1"),
    OPENROUTER_IMAGE_BASE_URL: z
      .string()
      .url()
      .default("https://openrouter.ai"),
    OPENROUTER_IMAGE_MODEL: z.string().default("openai/gpt-5.4-image-2"),
    OPENROUTER_IMAGE_ALLOWED_HOSTS: z
      .string()
      .default("openrouter.ai,.openai.com,.oaistatic.com"),
    GEEKDANCE_LOGO_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-logo.png"),
    GEEKDANCE_ARTICLE_ILLUSTRATION_LOGO_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-article-illustration-logo.png"),
    GEEKDANCE_MASCOT_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-mascot.png"),
    CONTENT_ENGINE_MODE: z
      .enum(["mock", "mock_geekhome", "openrouter", "openai"])
      .default("mock"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    OPENAI_IMAGE_API_KEY: z.string().optional(),
    OPENAI_IMAGE_BASE_URL: z
      .string()
      .url()
      .default("https://api.openai.com/v1"),
    OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
    OPENAI_IMAGE_ALLOWED_HOSTS: z
      .string()
      .default("api.openai.com,.openai.com,.oaistatic.com"),
    OPENAI_TEXT_MODEL: z.string().default("gpt-5.6-sol"),
    OPENAI_RESEARCH_FALLBACK_MODEL: z.string().optional(),
    OPENAI_RESEARCH_MODEL: z.string().optional(),
    OPENAI_REASONING_EFFORT: z
      .enum(["none", "low", "medium", "high", "xhigh", "max"])
      .default("medium"),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_TEXT_API_KEY: z.string().optional(),
    OPENROUTER_IMAGE_API_KEY: z.string().optional(),
    OPENROUTER_TEXT_MODEL: z.string().default("qwen/qwen3.7-plus"),
    OPENROUTER_TEXT_FALLBACK_MODELS: z
      .string()
      .default(
        "qwen/qwen3.7-plus,qwen/qwen3.5-plus-20260420,deepseek/deepseek-v4-pro",
      )
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    OPENROUTER_TEXT_PROVIDER_ORDER: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    OPENROUTER_TEXT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(600_000)
      .default(240_000),
    ASSET_PUBLIC_BASE_URL: z
      .string()
      .url()
      .default("https://aiops.geekdance.cn/api/public/assets"),
    ASSET_PUBLIC_SECRET: z.string().min(32).optional(),
    GEEKHOME_MATERIAL_MCP_URL: z.string().url().optional(),
    GEEKHOME_MATERIAL_TOKEN: z.string().optional(),
    OFFICIAL_PUBLISHER_MODE: z.enum(["off", "mock", "live"]).default("off"),
    OFFICIAL_BASE_URL: z.string().url().default("https://www.geekdance.cn"),
    OFFICIAL_ALLOW_PROD: z
      .string()
      .default("false")
      .transform((value) => value === "true"),
    OFFICIAL_ADMIN_TOKEN: z.string().optional(),
    OFFICIAL_ADMIN_USERNAME: z.string().optional(),
    OFFICIAL_ADMIN_PASSWORD: z.string().optional(),
    OFFICIAL_UPLOAD_DIR: z.string().default("ai-generated/blogs"),
    OFFICIAL_IMAGE_ALLOWED_HOSTS: z
      .string()
      .default("home.geekdance.app,.aliyuncs.com,.geekdance.cn"),
    WECHAT_PUBLISHER_MODE: z.enum(["off", "mock", "live"]).default("off"),
    WECHAT_ALLOW_PROD: z
      .string()
      .default("false")
      .transform((value) => value === "true"),
    WECHAT_APP_ID: z.string().optional(),
    WECHAT_APP_SECRET: z.string().optional(),
    WECHAT_API_BASE_URL: z.string().url().default("https://api.weixin.qq.com"),
    WECHAT_AUTHOR: z.string().default("极客跳动编辑部"),
    WECHAT_CONTENT_SOURCE_URL: z
      .string()
      .url()
      .default("https://www.geekdance.cn"),
    WECHAT_IMAGE_ALLOWED_HOSTS: z
      .string()
      .default("home.geekdance.app,.aliyuncs.com,.geekdance.cn"),
    WECHAT_PROMO_BOARD_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-promo-board.png"),
    WECHAT_BRAND_LOGO_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-logo.png"),
    WECHAT_CONTACT_QR_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-contact-qr.png"),
    WECHAT_COVER_LOCKUP_PATH: z
      .string()
      .default("apps/web/public/brand/geekdance-cover-lockup.png"),
  })
  .parse(process.env);

const generatedImageFontVerification = await verifyGeneratedImageFonts();
console.info(
  JSON.stringify({
    event: "generated_image_fonts_verified",
    verified: generatedImageFontVerification.verified,
  }),
);

function publicAssetUrl(assetId: string) {
  if (!env.ASSET_PUBLIC_SECRET) throw new Error("ASSET_PUBLIC_SECRET_MISSING");
  const signature = createHmac("sha256", env.ASSET_PUBLIC_SECRET)
    .update(assetId)
    .digest("hex");
  return `${env.ASSET_PUBLIC_BASE_URL.replace(/\/$/, "")}/${assetId}/${signature}`;
}

async function loadAssetBytes(assetId: string) {
  const result = await db.query(
    `SELECT assets.storage_key, asset_blobs.bytes
     FROM assets LEFT JOIN asset_blobs ON asset_blobs.asset_id = assets.id
     WHERE assets.id = $1 AND assets.kind = 'image' AND assets.status = 'ready'`,
    [assetId],
  );
  const row = result.rows[0];
  if (row?.bytes) return new Uint8Array(row.bytes);
  if (row?.storage_key)
    return new Uint8Array(
      await readFile(join(env.ASSET_STORAGE_DIR, row.storage_key)),
    );
  throw new Error("COVER_ASSET_FILE_MISSING");
}

async function persistDerivedCover(
  createdBy: string,
  contentJobId: string,
  bytes: Uint8Array,
  role: string,
) {
  const id = randomUUID();
  const storageKey = `${id}.jpg`;
  await writeFile(join(env.ASSET_STORAGE_DIR, storageKey), bytes, {
    mode: 0o644,
    flag: "wx",
  });
  await assetStore?.put(storageKey, bytes, "image/jpeg");
  await db.query(
    `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
     VALUES ($1, $2, 'cover_branding', 'image', 'ready', $3, 'image/jpeg', $4::jsonb)`,
    [
      id,
      createdBy,
      storageKey,
      JSON.stringify({
        contentJobId,
        role,
        brandText: "GeekDance",
        ossBacked: Boolean(assetStore),
      }),
    ],
  );
  await db.query("INSERT INTO asset_blobs (asset_id, bytes) VALUES ($1, $2)", [
    id,
    Buffer.from(bytes),
  ]);
  return publicAssetUrl(id);
}
const officialOpenAiText = env.CONTENT_ENGINE_MODE === "openai";
const textApiKey = officialOpenAiText
  ? firstNonEmpty(env.OPENAI_API_KEY)
  : firstNonEmpty(env.OPENROUTER_TEXT_API_KEY, env.OPENROUTER_API_KEY);
const textModel = officialOpenAiText
  ? env.OPENAI_TEXT_MODEL
  : env.OPENROUTER_TEXT_MODEL;
const textBaseUrl = officialOpenAiText
  ? env.OPENAI_BASE_URL
  : env.OPENROUTER_TEXT_BASE_URL;
const openAiResearchFallbackModel =
  firstNonEmpty(
    env.OPENAI_RESEARCH_FALLBACK_MODEL,
    env.OPENAI_RESEARCH_MODEL,
  ) ?? "gpt-5.4";
const officialOpenAiImage = env.IMAGE_PROVIDER_MODE === "openai";
const imageApiKey = officialOpenAiImage
  ? firstNonEmpty(env.OPENAI_IMAGE_API_KEY, env.OPENAI_API_KEY)
  : firstNonEmpty(env.OPENROUTER_IMAGE_API_KEY, env.OPENROUTER_API_KEY);
const imageBaseUrl = officialOpenAiImage
  ? env.OPENAI_IMAGE_BASE_URL
  : env.OPENROUTER_IMAGE_BASE_URL;
const imageModel = officialOpenAiImage
  ? env.OPENAI_IMAGE_MODEL
  : env.OPENROUTER_IMAGE_MODEL;
const imageAllowedHosts = (
  officialOpenAiImage
    ? env.OPENAI_IMAGE_ALLOWED_HOSTS
    : env.OPENROUTER_IMAGE_ALLOWED_HOSTS
)
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const assetStore = createOssAssetStore({
  endpoint: env.OSS_ENDPOINT,
  bucket: env.OSS_BUCKET,
  prefix: env.OSS_PREFIX,
  accessKeyId: env.OSS_ACCESS_KEY_ID,
  accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
});
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
const contentQueue = new Queue(env.CONTENT_QUEUE_NAME, { connection });
const runtimeKey = `geekdance:worker:runtime:${env.CONTENT_QUEUE_NAME}:${env.IMAGE_QUEUE_NAME}`;
const runtimeSnapshot = (): WorkerRuntimeSnapshot => ({
  release: env.APP_RELEASE,
  recordedAt: new Date().toISOString(),
  contentEngineMode: env.CONTENT_ENGINE_MODE,
  imageProviderMode: env.IMAGE_PROVIDER_MODE,
  officialPublisherMode: env.OFFICIAL_PUBLISHER_MODE,
  officialAllowProduction: env.OFFICIAL_ALLOW_PROD,
  wechatPublisherMode: env.WECHAT_PUBLISHER_MODE,
  wechatAllowProduction: env.WECHAT_ALLOW_PROD,
  textModel,
  imageModel,
  textKeyConfigured: Boolean(textApiKey),
  imageKeyConfigured: Boolean(imageApiKey),
  geekHomeConfigured: Boolean(
    env.GEEKHOME_MATERIAL_MCP_URL && env.GEEKHOME_MATERIAL_TOKEN,
  ),
  assetPublicSecretConfigured: Boolean(env.ASSET_PUBLIC_SECRET),
});
async function publishRuntimeHeartbeat() {
  await connection.set(runtimeKey, JSON.stringify(runtimeSnapshot()), "EX", 30);
}
await publishRuntimeHeartbeat();
const runtimeHeartbeat = setInterval(() => {
  void publishRuntimeHeartbeat().catch(() => undefined);
}, 10_000);
runtimeHeartbeat.unref();
const officialPublisher = new OfficialSitePublisher({
  mode: env.OFFICIAL_PUBLISHER_MODE,
  baseUrl: env.OFFICIAL_BASE_URL,
  allowProduction: env.OFFICIAL_ALLOW_PROD,
  bearerToken: env.OFFICIAL_ADMIN_TOKEN,
  username: env.OFFICIAL_ADMIN_USERNAME,
  password: env.OFFICIAL_ADMIN_PASSWORD,
  uploadDir: env.OFFICIAL_UPLOAD_DIR,
  allowedImageHosts: env.OFFICIAL_IMAGE_ALLOWED_HOSTS.split(",")
    .map((host) => host.trim())
    .filter(Boolean),
});

class RedisWechatTokenStore implements WechatTokenStore {
  private readonly tokenKey: string;
  private readonly lockKey: string;

  constructor(
    private readonly redis: Redis,
    appId: string,
  ) {
    const namespace = createHash("sha256")
      .update(appId || "unconfigured")
      .digest("hex")
      .slice(0, 20);
    this.tokenKey = `wechat:access-token:${namespace}`;
    this.lockKey = `wechat:access-token-lock:${namespace}`;
  }

  async get(): Promise<WechatTokenRecord | null> {
    const value = await this.redis.get(this.tokenKey);
    if (!value) return null;
    try {
      const parsed = z
        .object({ accessToken: z.string().min(1), expiresAt: z.number() })
        .parse(JSON.parse(value));
      return parsed;
    } catch {
      await this.redis.del(this.tokenKey);
      return null;
    }
  }

  async set(record: WechatTokenRecord, ttlSeconds: number) {
    await this.redis.set(
      this.tokenKey,
      JSON.stringify(record),
      "EX",
      Math.max(60, ttlSeconds),
    );
  }

  async clear() {
    await this.redis.del(this.tokenKey);
  }

  async withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
    const lockToken = randomUUID();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const acquired = await this.redis.set(
        this.lockKey,
        lockToken,
        "PX",
        20_000,
        "NX",
      );
      if (acquired === "OK") {
        try {
          return await task();
        } finally {
          await this.redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            this.lockKey,
            lockToken,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new WechatPublisherError(
      "WECHAT_TOKEN_LOCK_TIMEOUT",
      "等待微信公众号 Access Token 刷新锁超时",
    );
  }
}

const wechatPublisher = new WechatOfficialPublisher({
  mode: env.WECHAT_PUBLISHER_MODE,
  allowProduction: env.WECHAT_ALLOW_PROD,
  appId: env.WECHAT_APP_ID,
  appSecret: env.WECHAT_APP_SECRET,
  apiBaseUrl: env.WECHAT_API_BASE_URL,
  author:
    env.WECHAT_AUTHOR.trim() === "极客跳动"
      ? "极客跳动编辑部"
      : env.WECHAT_AUTHOR.trim(),
  contentSourceUrl: env.WECHAT_CONTENT_SOURCE_URL,
  promoBoardPath: env.WECHAT_PROMO_BOARD_PATH,
  brandLogoPath: env.WECHAT_BRAND_LOGO_PATH,
  contactQrPath: env.WECHAT_CONTACT_QR_PATH,
  allowedImageHosts: env.WECHAT_IMAGE_ALLOWED_HOSTS.split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  tokenStore: new RedisWechatTokenStore(connection, env.WECHAT_APP_ID ?? ""),
});
const wechatCoverStyleVersion = WECHAT_COVER_STYLE_VERSION;

type PipelineResult = Awaited<ReturnType<typeof runContentPipeline>>;
type ReadyPipeline = Extract<PipelineResult, { status: "ready" }>;
const safeAttachmentStorageKey = /^[0-9a-f-]{36}\.(?:pdf|docx|txt|md|png|jpg)$/;

async function loadResearchAttachments(ids: string[]) {
  if (!ids.length) return [];
  const result = await db.query(
    "SELECT id, storage_key, mime_type, metadata FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'attachment' AND status = 'ready'",
    [ids],
  );
  const order = new Map(ids.map((id, index) => [id, index]));
  result.rows.sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  if (result.rows.length !== ids.length)
    throw new Error("CONTENT_ATTACHMENT_MISSING");
  return Promise.all(
    result.rows.map(async (row): Promise<ResearchAttachment> => {
      if (!safeAttachmentStorageKey.test(row.storage_key ?? ""))
        throw new Error("CONTENT_ATTACHMENT_STORAGE_INVALID");
      const mimeType = String(row.mime_type ?? "application/octet-stream");
      const attachment: ResearchAttachment = {
        id: row.id,
        name: String(row.metadata?.originalName ?? "附件"),
        mimeType,
      };
      if (typeof row.metadata?.extractedText === "string")
        attachment.extractedText = row.metadata.extractedText;
      if (mimeType === "image/png" || mimeType === "image/jpeg") {
        const bytes = await readFile(
          join(env.ASSET_STORAGE_DIR, row.storage_key),
        );
        attachment.dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
      }
      return attachment;
    }),
  );
}

function cachedReadyPipeline(row: Record<string, any>): ReadyPipeline | null {
  const result = row.result;
  if (
    result?.contentStatus !== "ready" ||
    !result.article ||
    !result.channelArtifacts ||
    !result.templateVersions ||
    !Array.isArray(result.assets) ||
    !Array.isArray(row.evidence) ||
    !row.qa_report
  )
    return null;
  return {
    status: "ready",
    workflowVersion: row.workflow_version || "cached",
    systemPromptVersion: row.workflow_version || "cached",
    evidence: row.evidence,
    article: result.article,
    qaReport: row.qa_report,
    websiteHtml: result.officialSiteHtml,
    wechatHtml: result.wechatHtml,
    xiaohongshuHtml: result.xiaohongshuHtml,
    zhihuHtml: result.zhihuHtml,
    toutiaoHtml: result.toutiaoHtml,
    baijiahaoHtml: result.baijiahaoHtml,
    linkedinHtml: result.linkedinHtml,
    assets: result.assets,
    channelArtifacts: result.channelArtifacts,
    templateVersions: result.templateVersions,
  } as ReadyPipeline;
}

const imageCandidateJobName = "generate-content-image-candidates";

async function updateImageCandidateGeneration(
  contentJobId: string,
  state: Record<string, unknown>,
) {
  await db.query(
    `UPDATE content_jobs
     SET result = jsonb_set(COALESCE(result, '{}'::jsonb), '{imageSuggestionGeneration}', $1::jsonb, true),
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(state), contentJobId],
  );
}

async function generateImageCandidatesForExistingJob(
  job: Job,
  row: Record<string, any>,
) {
  const contentJobId = z.string().uuid().parse(job.data.contentJobId);
  const request = contentJobRequestSchema.parse(row.input);
  if (env.IMAGE_PROVIDER_MODE === "mock" && request.contentType === "case")
    throw new Error("CONTENT_IMAGE_PROVIDER_NOT_LIVE");
  if (!env.ASSET_PUBLIC_SECRET) throw new Error("ASSET_PUBLIC_SECRET_MISSING");

  const channel = request.targets.includes("official_site")
    ? "official_site"
    : request.targets.includes("wechat")
      ? "wechat"
      : request.targets.includes("xiaohongshu")
        ? "xiaohongshu"
        : undefined;
  if (!channel) throw new Error("CONTENT_IMAGE_TARGET_MISSING");

  const attachments = await loadResearchAttachments(request.attachmentIds);
  const evidence = z
    .array(evidenceItemSchema)
    .catch([])
    .parse(Array.isArray(row.evidence) ? row.evidence : []);
  const expectedTotal =
    request.contentType === "case"
      ? (request.caseVisualTypes?.length ?? 0)
      : 6 + (request.targets.includes("xiaohongshu") ? 1 : 0);
  const usedTextModels = new Set<string>();
  const startedAt = new Date().toISOString();

  await updateImageCandidateGeneration(contentJobId, {
    status: "running",
    completed: 0,
    total: expectedTotal,
    message: "正在根据文章章节生成候选插图",
    startedAt,
  });

  {
    const storedArticle =
      row.result?.channelArticles?.[channel] ??
      row.result?.channelArtifacts?.[channel]?.article ??
      row.result?.article;
    const article = coreArticleSchema.parse(storedArticle);
    const layoutRequest = contentJobRequestSchema.parse({
      ...request,
      imageMode: "generated",
      targets: [channel],
    });
    const candidates = await generateContentImages(
      {
        db,
        createdBy: row.created_by,
        contentJobId,
        storageDir: env.ASSET_STORAGE_DIR,
        imageServiceUrl: env.IMAGE_SERVICE_URL,
        logoPath: env.GEEKDANCE_LOGO_PATH,
        articleIllustrationLogoPath:
          env.GEEKDANCE_ARTICLE_ILLUSTRATION_LOGO_PATH,
        mascotPath: env.GEEKDANCE_MASCOT_PATH,
        publicBaseUrl: env.ASSET_PUBLIC_BASE_URL,
        publicSecret: env.ASSET_PUBLIC_SECRET,
        providerMode:
          env.IMAGE_PROVIDER_MODE === "mock"
            ? "openai"
            : env.IMAGE_PROVIDER_MODE,
        imageApiKey,
        imageBaseUrl,
        model: imageModel,
        allowedResultHosts: imageAllowedHosts,
        allowDeterministicFallback: env.IMAGE_PROVIDER_MODE === "mock",
        assetStore,
        caseDiagramSpecGenerator: (
          caseRequest,
          caseEvidence,
          caseAttachments,
        ) =>
          generateCaseDiagramSpecs(
            {
              textProvider: officialOpenAiText ? "openai" : "openrouter",
              openRouterApiKey: textApiKey ?? "",
              openRouterModel: textModel,
              openRouterFallbackModels: officialOpenAiText
                ? []
                : env.OPENROUTER_TEXT_FALLBACK_MODELS,
              openRouterProviderOrder: env.OPENROUTER_TEXT_PROVIDER_ORDER,
              openRouterTextBaseUrl: textBaseUrl,
              openRouterTimeoutMs: env.OPENROUTER_TEXT_TIMEOUT_MS,
              openAiReasoningEffort: env.OPENAI_REASONING_EFFORT,
              openAiResearchFallbackModel,
              geekHomeUrl: env.GEEKHOME_MATERIAL_MCP_URL ?? "",
              geekHomeToken: env.GEEKHOME_MATERIAL_TOKEN ?? "",
              usageRecorder: async ({ totalTokens, costCents }) => {
                await db.query(
                  "UPDATE content_jobs SET text_tokens = text_tokens + $1, text_cost_cents = text_cost_cents + $2 WHERE id = $3",
                  [totalTokens, costCents, contentJobId],
                );
              },
              modelRecorder: (model) => {
                usedTextModels.add(model);
              },
            },
            caseRequest,
            caseEvidence,
            caseAttachments,
          ),
      },
      layoutRequest,
      article,
      evidence,
      attachments,
      async (completed, total) => {
        const overallCompleted = completed;
        await job.updateProgress(
          Math.min(99, Math.round((overallCompleted / expectedTotal) * 100)),
        );
        await updateImageCandidateGeneration(contentJobId, {
          status: "running",
          completed: overallCompleted,
          total: expectedTotal,
          message: `正在生成内容配图（${completed}/${total}）`,
          startedAt,
        });
      },
    );
  }

  const assetCount = await db.query(
    `SELECT COUNT(*)::int AS count FROM assets
     WHERE kind = 'image' AND status = 'ready'
       AND metadata->>'contentJobId' = $1
       AND COALESCE(metadata->>'role', '') IN ('cover', 'inline')`,
    [contentJobId],
  );
  await job.updateProgress(100);
  await updateImageCandidateGeneration(contentJobId, {
    status: "completed",
    completed: assetCount.rows[0].count,
    total: assetCount.rows[0].count,
    message: `已根据文章内容生成 ${assetCount.rows[0].count} 张候选图`,
    completedAt: new Date().toISOString(),
  });
  return { jobId: contentJobId, generated: assetCount.rows[0].count };
}

async function updateProgress(
  id: string,
  stage: JobStatus,
  percent: number,
  message: string,
) {
  const result = await db.query(
    "UPDATE content_jobs SET status = $1, progress = $2::jsonb, updated_at = NOW() WHERE id = $3 AND status <> 'cancelled' RETURNING status",
    [stage, JSON.stringify({ stage, percent, message }), id],
  );
  return Boolean(result.rowCount);
}

async function syncAutomationRunStatus(
  contentJobId: string,
  status: JobStatus,
  errorCode?: string,
) {
  await db.query(
    `UPDATE automation_schedule_runs
     SET status = $1, error_code = $2, updated_at = NOW()
     WHERE content_job_id = $3`,
    [status, errorCode ?? null, contentJobId],
  );
}

const worker = new Worker(
  env.CONTENT_QUEUE_NAME,
  async (job) => {
    const contentJobId = z.string().uuid().parse(job.data.contentJobId);
    const rowResult = await db.query(
      "SELECT * FROM content_jobs WHERE id = $1",
      [contentJobId],
    );
    if (!rowResult.rowCount || rowResult.rows[0].status === "cancelled")
      return { jobId: contentJobId, skipped: true };
    const row = rowResult.rows[0];
    const request = contentJobRequestSchema.parse(row.input);
    if (job.name === imageCandidateJobName)
      return generateImageCandidatesForExistingJob(job, row);
    if (env.NODE_ENV === "production") {
      const issues = contentRuntimeIssues(runtimeSnapshot(), request);
      if (issues.length)
        throw new Error(
          `PRODUCTION_RUNTIME_NOT_READY:${issues.map((issue) => issue.code).join(",")}`,
        );
    }
    const isReviewedTargetPublish = job.name === "publish-reviewed-target";
    const isChannelRetry =
      isReviewedTargetPublish || job.name === "retry-failed-draft-targets";
    let deliveryTargets = request.targets;
    if (isReviewedTargetPublish) {
      const targetId = z.string().uuid().parse(job.data.targetId);
      const reviewedTarget = await db.query(
        `SELECT target FROM job_targets
         WHERE id = $1 AND job_id = $2 AND status = 'queued'`,
        [targetId, contentJobId],
      );
      if (!reviewedTarget.rowCount)
        return { jobId: contentJobId, targetId, skipped: true };
      deliveryTargets = request.targets.filter(
        (target) => target === reviewedTarget.rows[0].target,
      );
      if (!deliveryTargets.length)
        return { jobId: contentJobId, targetId, skipped: true };
    }
    let pipeline: PipelineResult | null = isChannelRetry
      ? cachedReadyPipeline(row)
      : null;
    const usedTextModels = new Set<string>();
    const phaseWeights = new Map<string, number>([["research", 2]]);
    for (const channel of request.targets) {
      phaseWeights.set(`${channel}:write`, 3);
      phaseWeights.set(
        `${channel}:assets`,
        request.imageMode === "generated" ? 4 : 2,
      );
      phaseWeights.set(`${channel}:qa`, 2);
    }
    const phaseFractions = new Map<string, number>();
    const totalPhaseWeight = [...phaseWeights.values()].reduce(
      (total, weight) => total + weight,
      0,
    );
    let lastPipelinePercent = 0;
    let lastPipelineStage: ContentPipelineProgress["stage"] = "researching";
    const pipelineStageRank = { researching: 0, writing: 1, formatting: 2 };
    let progressWrite = Promise.resolve();
    const reportPipelineProgress = (progress: ContentPipelineProgress) => {
      progressWrite = progressWrite.then(async () => {
        const previous = phaseFractions.get(progress.phase) ?? 0;
        phaseFractions.set(
          progress.phase,
          Math.max(previous, Math.min(1, Math.max(0, progress.fraction))),
        );
        const completedWeight = [...phaseWeights].reduce(
          (total, [phase, weight]) =>
            total + weight * (phaseFractions.get(phase) ?? 0),
          0,
        );
        const percent = Math.max(
          lastPipelinePercent,
          Math.min(
            82,
            5 + Math.round((completedWeight / totalPhaseWeight) * 77),
          ),
        );
        lastPipelinePercent = percent;
        if (
          pipelineStageRank[progress.stage] >
          pipelineStageRank[lastPipelineStage]
        )
          lastPipelineStage = progress.stage;
        await updateProgress(
          contentJobId,
          lastPipelineStage,
          percent,
          progress.message,
        );
        await job.updateProgress(percent);
      });
      return progressWrite;
    };

    if (!pipeline) {
      const ports = ["openrouter", "openai"].includes(env.CONTENT_ENGINE_MODE)
        ? createLivePorts({
            textProvider: officialOpenAiText ? "openai" : "openrouter",
            openRouterApiKey: textApiKey ?? "",
            openRouterModel: textModel,
            openRouterFallbackModels: officialOpenAiText
              ? []
              : env.OPENROUTER_TEXT_FALLBACK_MODELS,
            openRouterProviderOrder: env.OPENROUTER_TEXT_PROVIDER_ORDER,
            openRouterTextBaseUrl: textBaseUrl,
            openRouterTimeoutMs: env.OPENROUTER_TEXT_TIMEOUT_MS,
            openAiReasoningEffort: env.OPENAI_REASONING_EFFORT,
            openAiResearchFallbackModel,
            geekHomeUrl: env.GEEKHOME_MATERIAL_MCP_URL ?? "",
            geekHomeToken: env.GEEKHOME_MATERIAL_TOKEN ?? "",
            usageRecorder: async ({ totalTokens, costCents }) => {
              await db.query(
                "UPDATE content_jobs SET text_tokens = text_tokens + $1, text_cost_cents = text_cost_cents + $2 WHERE id = $3",
                [totalTokens, costCents, contentJobId],
              );
            },
            modelRecorder: (model) => {
              usedTextModels.add(model);
            },
            imageGenerator: async (
              input,
              article,
              evidence,
              attachments,
              onProgress,
            ) => {
              if (
                env.IMAGE_PROVIDER_MODE === "mock" &&
                input.contentType === "case"
              )
                throw new Error("CONTENT_IMAGE_PROVIDER_NOT_LIVE");
              if (!env.ASSET_PUBLIC_SECRET)
                throw new Error("ASSET_PUBLIC_SECRET_MISSING");
              return generateContentImages(
                {
                  db,
                  createdBy: row.created_by,
                  contentJobId,
                  storageDir: env.ASSET_STORAGE_DIR,
                  imageServiceUrl: env.IMAGE_SERVICE_URL,
                  logoPath: env.GEEKDANCE_LOGO_PATH,
                  articleIllustrationLogoPath:
                    env.GEEKDANCE_ARTICLE_ILLUSTRATION_LOGO_PATH,
                  mascotPath: env.GEEKDANCE_MASCOT_PATH,
                  publicBaseUrl: env.ASSET_PUBLIC_BASE_URL,
                  publicSecret: env.ASSET_PUBLIC_SECRET,
                  providerMode:
                    env.IMAGE_PROVIDER_MODE === "mock"
                      ? "openai"
                      : env.IMAGE_PROVIDER_MODE,
                  imageApiKey,
                  imageBaseUrl,
                  model: imageModel,
                  allowedResultHosts: imageAllowedHosts,
                  allowDeterministicFallback:
                    env.IMAGE_PROVIDER_MODE === "mock",
                  assetStore,
                  caseDiagramSpecGenerator: (
                    caseRequest,
                    caseEvidence,
                    caseAttachments,
                  ) =>
                    generateCaseDiagramSpecs(
                      {
                        textProvider: officialOpenAiText
                          ? "openai"
                          : "openrouter",
                        openRouterApiKey: textApiKey ?? "",
                        openRouterModel: textModel,
                        openRouterFallbackModels: officialOpenAiText
                          ? []
                          : env.OPENROUTER_TEXT_FALLBACK_MODELS,
                        openRouterProviderOrder:
                          env.OPENROUTER_TEXT_PROVIDER_ORDER,
                        openRouterTextBaseUrl: textBaseUrl,
                        openRouterTimeoutMs: env.OPENROUTER_TEXT_TIMEOUT_MS,
                        openAiReasoningEffort: env.OPENAI_REASONING_EFFORT,
                        openAiResearchFallbackModel,
                        geekHomeUrl: env.GEEKHOME_MATERIAL_MCP_URL ?? "",
                        geekHomeToken: env.GEEKHOME_MATERIAL_TOKEN ?? "",
                        usageRecorder: async ({ totalTokens, costCents }) => {
                          await db.query(
                            "UPDATE content_jobs SET text_tokens = text_tokens + $1, text_cost_cents = text_cost_cents + $2 WHERE id = $3",
                            [totalTokens, costCents, contentJobId],
                          );
                        },
                        modelRecorder: (model) => {
                          usedTextModels.add(model);
                        },
                      },
                      caseRequest,
                      caseEvidence,
                      caseAttachments,
                    ),
                },
                input,
                article,
                evidence,
                attachments,
                onProgress,
              );
            },
          })
        : env.CONTENT_ENGINE_MODE === "mock_geekhome"
          ? {
              ...mockPorts,
              searchMaterials: (input: typeof request) =>
                searchGeekHomeMaterials(
                  {
                    geekHomeUrl: env.GEEKHOME_MATERIAL_MCP_URL ?? "",
                    geekHomeToken: env.GEEKHOME_MATERIAL_TOKEN ?? "",
                  },
                  input,
                ),
            }
          : undefined;
      const attachments = await loadResearchAttachments(request.attachmentIds);
      pipeline = await runContentPipeline(
        request,
        ports,
        attachments,
        reportPipelineProgress,
      );
      await progressWrite;
    }
    if (!pipeline) throw new Error("CONTENT_PIPELINE_RESULT_MISSING");

    const stateAfterPipeline = await db.query(
      "SELECT status FROM content_jobs WHERE id = $1",
      [contentJobId],
    );
    if (stateAfterPipeline.rows[0]?.status === "cancelled") {
      await db.query(
        "UPDATE job_targets SET status = 'cancelled', updated_at = NOW() WHERE job_id = $1 AND status = 'queued'",
        [contentJobId],
      );
      await syncAutomationRunStatus(contentJobId, "cancelled");
      return { jobId: contentJobId, status: "cancelled" };
    }

    if (pipeline.status === "manual_review") {
      await db.query(
        `UPDATE content_jobs SET status = 'manual_review', evidence = $1::jsonb, qa_report = $2::jsonb,
         result = $3::jsonb, workflow_version = $4, template_versions = $5::jsonb,
         progress = $6::jsonb, updated_at = NOW() WHERE id = $7 AND status <> 'cancelled'`,
        [
          JSON.stringify(pipeline.evidence ?? []),
          JSON.stringify(pipeline.qaReport ?? null),
          JSON.stringify({
            contentStatus: "blocked",
            article: pipeline.article,
            officialSiteHtml: pipeline.websiteHtml,
            wechatHtml: pipeline.wechatHtml,
            xiaohongshuHtml: pipeline.xiaohongshuHtml,
            zhihuHtml: pipeline.zhihuHtml,
            toutiaoHtml: pipeline.toutiaoHtml,
            baijiahaoHtml: pipeline.baijiahaoHtml,
            linkedinHtml: pipeline.linkedinHtml,
            assets: pipeline.assets,
            channelArticles: Object.fromEntries(
              Object.entries(pipeline.channelArtifacts ?? {}).flatMap(
                ([channel, artifact]) =>
                  artifact?.article ? [[channel, artifact.article]] : [],
              ),
            ),
            channelArtifacts: pipeline.channelArtifacts,
            templateVersions: pipeline.templateVersions,
            runtime: {
              contentEngineMode: env.CONTENT_ENGINE_MODE,
              imageProviderMode: env.IMAGE_PROVIDER_MODE,
              textModel: [...usedTextModels].join(", ") || textModel,
              imageModel,
            },
            manualReviewReason: pipeline.reason,
            route: "route" in pipeline ? pipeline.route : undefined,
          }),
          pipeline.workflowVersion,
          JSON.stringify(pipeline.templateVersions ?? {}),
          JSON.stringify({
            stage: "manual_review",
            percent: 100,
            message: pipeline.reason,
          }),
          contentJobId,
        ],
      );
      await db.query(
        "UPDATE job_targets SET status = 'manual_review', error_code = 'CONTENT_REVIEW_REQUIRED', updated_at = NOW() WHERE job_id = $1 AND status <> 'drafted'",
        [contentJobId],
      );
      await syncAutomationRunStatus(contentJobId, "manual_review");
      return { jobId: contentJobId, status: "manual_review" };
    }

    await updateProgress(
      contentJobId,
      "formatting",
      83,
      "内容、配图、渠道排版与质检已完成",
    );
    await job.updateProgress(83);
    if (!isChannelRetry)
      await db.query(
        `UPDATE content_jobs SET evidence = $1::jsonb, qa_report = $2::jsonb, result = $3::jsonb,
         workflow_version = $4, template_versions = $5::jsonb, updated_at = NOW()
         WHERE id = $6 AND status <> 'cancelled'`,
        [
          JSON.stringify(pipeline.evidence),
          JSON.stringify(pipeline.qaReport),
          JSON.stringify({
            contentStatus: "ready",
            article: pipeline.article,
            officialSiteHtml: pipeline.websiteHtml,
            wechatHtml: pipeline.wechatHtml,
            xiaohongshuHtml: pipeline.xiaohongshuHtml,
            zhihuHtml: pipeline.zhihuHtml,
            toutiaoHtml: pipeline.toutiaoHtml,
            baijiahaoHtml: pipeline.baijiahaoHtml,
            linkedinHtml: pipeline.linkedinHtml,
            assets: pipeline.assets,
            channelArticles: Object.fromEntries(
              Object.entries(pipeline.channelArtifacts).flatMap(
                ([channel, artifact]) =>
                  artifact?.article ? [[channel, artifact.article]] : [],
              ),
            ),
            channelArtifacts: pipeline.channelArtifacts,
            templateVersions: pipeline.templateVersions,
            runtime: {
              contentEngineMode: env.CONTENT_ENGINE_MODE,
              imageProviderMode: env.IMAGE_PROVIDER_MODE,
              textModel: [...usedTextModels].join(", ") || textModel,
              imageModel,
            },
          }),
          pipeline.workflowVersion,
          JSON.stringify(pipeline.templateVersions),
          contentJobId,
        ],
      );
    for (const channel of deliveryTargets) {
      const artifact = pipeline.channelArtifacts[channel];
      if (artifact?.status === "manual_review")
        await db.query(
          `UPDATE job_targets
           SET status = 'manual_review', error_code = 'CHANNEL_CONTENT_REVIEW_REQUIRED',
               provider_state = provider_state || $1::jsonb, updated_at = NOW()
           WHERE job_id = $2 AND target = $3 AND status <> 'drafted'`,
          [
            JSON.stringify({
              template: artifact.template,
              reviewReason: artifact.reason,
            }),
            contentJobId,
            channel,
          ],
        );
      else if (artifact?.status === "ready")
        await db.query(
          `UPDATE job_targets
           SET provider_state = provider_state || $1::jsonb, updated_at = NOW()
           WHERE job_id = $2 AND target = $3`,
          [
            JSON.stringify({ template: artifact.template }),
            contentJobId,
            channel,
          ],
        );
    }
    if (request.requireReviewBeforeDraft && !isChannelRetry) {
      const message =
        "内容与渠道排版已生成，请在人工复核中修改文章、配图和封面，通过后再创建渠道草稿";
      await db.query(
        `UPDATE job_targets
         SET status = 'manual_review', error_code = 'CONTENT_REVIEW_REQUIRED',
             provider_state = provider_state || $1::jsonb, updated_at = NOW()
         WHERE job_id = $2 AND status = 'queued'`,
        [JSON.stringify({ reviewReason: message }), contentJobId],
      );
      await db.query(
        `UPDATE content_jobs SET status = 'manual_review',
         progress = $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND status <> 'cancelled'`,
        [
          JSON.stringify({
            stage: "manual_review",
            percent: 100,
            message,
          }),
          contentJobId,
        ],
      );
      await syncAutomationRunStatus(contentJobId, "manual_review");
      return { jobId: contentJobId, status: "manual_review" };
    }
    if (request.includeGeekHome && !isChannelRetry) {
      const message =
        "AI 章节结构插图已生成；请在智能配图中多选 GeekHome 素材并指定正文或渠道封面用途";
      await db.query(
        `UPDATE job_targets
         SET status = 'manual_review', error_code = 'GEEKHOME_SELECTION_REQUIRED',
             provider_state = provider_state || $1::jsonb, updated_at = NOW()
         WHERE job_id = $2 AND status = 'queued'`,
        [JSON.stringify({ reviewReason: message }), contentJobId],
      );
      await db.query(
        `UPDATE content_jobs SET status = 'manual_review',
         progress = $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND status <> 'cancelled'`,
        [
          JSON.stringify({
            stage: "manual_review",
            percent: 100,
            message,
          }),
          contentJobId,
        ],
      );
      await syncAutomationRunStatus(contentJobId, "manual_review");
      return { jobId: contentJobId, status: "manual_review" };
    }
    await updateProgress(
      contentJobId,
      "publishing",
      84,
      "内容已就绪，准备写入所选渠道草稿箱",
    );
    await job.updateProgress(84);

    const cancellation = await db.query(
      "SELECT status FROM content_jobs WHERE id = $1",
      [contentJobId],
    );
    if (cancellation.rows[0]?.status === "cancelled") {
      await db.query(
        "UPDATE job_targets SET status = 'cancelled', updated_at = NOW() WHERE job_id = $1 AND status = 'queued'",
        [contentJobId],
      );
      await syncAutomationRunStatus(contentJobId, "cancelled");
      return { jobId: contentJobId, status: "cancelled" };
    }

    let completedDraftTargets = 0;
    const reportDraftTarget = async (message: string, complete = false) => {
      if (complete) completedDraftTargets += 1;
      const percent = complete
        ? Math.min(
            99,
            84 +
              Math.round((completedDraftTargets / deliveryTargets.length) * 15),
          )
        : Math.min(
            98,
            85 +
              Math.round((completedDraftTargets / deliveryTargets.length) * 15),
          );
      await updateProgress(contentJobId, "publishing", percent, message);
      await job.updateProgress(percent);
    };

    if (deliveryTargets.includes("official_site")) {
      await reportDraftTarget("正在上传官网图片并创建官网草稿");
      const artifact = pipeline.channelArtifacts.official_site;
      const current = await db.query(
        "SELECT status FROM job_targets WHERE job_id = $1 AND target = 'official_site'",
        [contentJobId],
      );
      if (current.rows[0]?.status === "publishing") {
        await db.query(
          "UPDATE job_targets SET status = 'manual_review', error_code = 'OFFICIAL_PUBLISH_INTERRUPTED', updated_at = NOW() WHERE job_id = $1 AND target = 'official_site'",
          [contentJobId],
        );
      } else if (
        current.rows[0]?.status === "queued" &&
        artifact?.status === "ready" &&
        artifact.article &&
        artifact.html
      ) {
        await db.query(
          "UPDATE job_targets SET status = 'publishing', error_code = NULL, updated_at = NOW() WHERE job_id = $1 AND target = 'official_site'",
          [contentJobId],
        );
        try {
          let coverImageUrl =
            artifact.reviewedCoverUrl ??
            (request.imageMode === "geekhome"
              ? artifact.assets[0]?.selected?.url
              : undefined);
          const uploadedOfficialCoverId = request.coverAssetIds?.officialSite;
          if (uploadedOfficialCoverId) {
            const styled = await applyGeekDanceWebsiteCoverStyle(
              await loadAssetBytes(uploadedOfficialCoverId),
            );
            coverImageUrl = await persistDerivedCover(
              row.created_by,
              contentJobId,
              styled.buffer,
              "official_site_cover",
            );
          }
          const materialIds = artifact.assets.flatMap((asset) =>
            asset.selected?.id ? [asset.selected.id] : [],
          );
          const draft = await officialPublisher.createDraft({
            operationId: request.operationId,
            confirmDraft: request.confirmDraft,
            title: artifact.article.title,
            description: artifact.article.description,
            contentHtml: artifact.html,
            category: request.primaryTag ?? "AI 技术",
            materialIds,
            coverImageUrl,
            metadata: {
              qaScore: pipeline.qaReport.score,
              workflowVersion: pipeline.workflowVersion,
              skillTemplate: artifact.template,
            },
          });
          await db.query(
            `UPDATE job_targets SET status = 'drafted', external_draft_id = $1, external_url = $2, content_fingerprint = $3,
             error_code = NULL, updated_at = NOW() WHERE job_id = $4 AND target = 'official_site'`,
            [
              draft.id,
              draft.externalUrl ?? null,
              draft.contentFingerprint,
              contentJobId,
            ],
          );
        } catch (error) {
          const publisherError =
            error instanceof OfficialPublisherError
              ? error
              : new OfficialPublisherError(
                  "OFFICIAL_DRAFT_FAILED",
                  error instanceof Error ? error.message : "官网草稿创建失败",
                );
          await db.query(
            "UPDATE job_targets SET status = $1, error_code = $2, updated_at = NOW() WHERE job_id = $3 AND target = 'official_site'",
            [
              publisherError.ambiguous ? "manual_review" : "failed",
              publisherError.code,
              contentJobId,
            ],
          );
        }
      }
      await reportDraftTarget("官网草稿处理已完成", true);
    }
    if (deliveryTargets.includes("wechat")) {
      await reportDraftTarget("正在上传公众号图片并创建公众号草稿");
      const artifact = pipeline.channelArtifacts.wechat;
      const current = await db.query(
        "SELECT status, provider_state FROM job_targets WHERE job_id = $1 AND target = 'wechat'",
        [contentJobId],
      );
      if (current.rows[0]?.status === "publishing") {
        await db.query(
          "UPDATE job_targets SET status = 'manual_review', error_code = 'WECHAT_PUBLISH_INTERRUPTED', updated_at = NOW() WHERE job_id = $1 AND target = 'wechat'",
          [contentJobId],
        );
      } else if (
        current.rows[0]?.status === "queued" &&
        artifact?.status === "ready" &&
        artifact.article &&
        artifact.html
      ) {
        await db.query(
          "UPDATE job_targets SET status = 'publishing', error_code = NULL, updated_at = NOW() WHERE job_id = $1 AND target = 'wechat'",
          [contentJobId],
        );
        try {
          const coverImageUrl =
            artifact.reviewedCoverUrl ??
            (request.imageMode === "geekhome"
              ? artifact.assets[0]?.selected?.url
              : undefined);
          const uploadedWideCoverId = request.coverAssetIds?.wechatWide;
          const uploadedSquareCoverId = request.coverAssetIds?.wechatSquare;
          const brandedReviewedCoverId =
            artifact.reviewedCover?.metadata?.wechatCoverStyleVersion ===
              wechatCoverStyleVersion &&
            typeof artifact.reviewedCover?.id === "string"
              ? artifact.reviewedCover.id
              : undefined;
          // A cover newly chosen in manual review must supersede any media ID
          // cached before that review. Otherwise WeChat would silently reuse
          // the old cover even though the operator can preview the new one.
          const existingCoverMatchesReview =
            !brandedReviewedCoverId ||
            current.rows[0]?.provider_state?.wechatCoverAssetId ===
              brandedReviewedCoverId;
          const existingCoverMediaId =
            existingCoverMatchesReview &&
            current.rows[0]?.provider_state?.wechatCoverStyleVersion ===
              wechatCoverStyleVersion &&
            typeof current.rows[0]?.provider_state?.wechatCoverMediaId ===
              "string"
              ? current.rows[0].provider_state.wechatCoverMediaId
              : undefined;
          let coverImageData:
            | {
                buffer: Uint8Array;
                mime: string;
                crops?: { square: string; wide: string };
              }
            | undefined;
          const coverBrandLockup = new Uint8Array(
            await readFile(env.WECHAT_COVER_LOCKUP_PATH),
          );
          if (!existingCoverMediaId && brandedReviewedCoverId) {
            coverImageData = {
              buffer: await loadAssetBytes(brandedReviewedCoverId),
              mime: "image/jpeg",
              crops: WECHAT_COVER_CROPS,
            };
          } else if (
            !existingCoverMediaId &&
            (uploadedWideCoverId || uploadedSquareCoverId)
          ) {
            const wideBytes = await loadAssetBytes(
              uploadedWideCoverId ?? uploadedSquareCoverId!,
            );
            const squareBytes = await loadAssetBytes(
              uploadedSquareCoverId ?? uploadedWideCoverId!,
            );
            coverImageData = await applyGeekDanceWechatCoverStyle(
              wideBytes,
              coverBrandLockup,
              squareBytes,
            );
          } else if (
            shouldCreateWechatFallbackCover({
              existingCoverMediaId,
              coverImageUrl,
              publisherMode: env.WECHAT_PUBLISHER_MODE,
            })
          ) {
            // Mock content intentionally uses non-routable material URLs. A
            // mock draft must stay fully offline instead of attempting to
            // download those placeholders through the production SSRF gate.
            coverImageData = await createGeekDanceWechatFallbackCover(
              artifact.article.title,
              coverBrandLockup,
            );
          } else if (!existingCoverMediaId && coverImageUrl) {
            try {
              const sourceCover = await downloadRemoteImage(
                coverImageUrl,
                env.WECHAT_IMAGE_ALLOWED_HOSTS.split(",")
                  .map((host) => host.trim())
                  .filter(Boolean),
              );
              coverImageData = await applyGeekDanceWechatCoverStyle(
                sourceCover.buffer,
                coverBrandLockup,
              );
            } catch (error) {
              throw new WechatPublisherError(
                "WECHAT_COVER_PROCESSING_FAILED",
                error instanceof Error
                  ? error.message
                  : "公众号封面下载或品牌化处理失败",
              );
            }
          }
          const draft = await wechatPublisher.createDraft({
            operationId: request.operationId,
            confirmDraft: request.confirmDraft,
            title: artifact.article.title,
            digest: artifact.article.description,
            contentHtml: artifact.html,
            coverImageUrl,
            coverImageData,
            coverCrops: WECHAT_COVER_CROPS,
            existingCoverMediaId,
            onCoverUploaded: async (mediaId) => {
              await db.query(
                "UPDATE job_targets SET provider_state = provider_state || $1::jsonb, updated_at = NOW() WHERE job_id = $2 AND target = 'wechat'",
                [
                  JSON.stringify({
                    wechatCoverMediaId: mediaId,
                    wechatCoverAssetId: brandedReviewedCoverId,
                    wechatCoverStyleVersion,
                  }),
                  contentJobId,
                ],
              );
            },
          });
          await db.query(
            `UPDATE job_targets SET status = 'drafted', external_draft_id = $1, external_url = $2, content_fingerprint = $3,
             provider_state = provider_state || $4::jsonb, error_code = NULL, updated_at = NOW()
             WHERE job_id = $5 AND target = 'wechat'`,
            [
              draft.id,
              draft.externalUrl,
              draft.contentFingerprint,
              JSON.stringify({
                wechatCoverMediaId: draft.coverMediaId,
                wechatCoverStyleVersion,
              }),
              contentJobId,
            ],
          );
        } catch (error) {
          const publisherError =
            error instanceof WechatPublisherError
              ? error
              : new WechatPublisherError(
                  "WECHAT_DRAFT_FAILED",
                  error instanceof Error ? error.message : "公众号草稿创建失败",
                );
          console.error(
            JSON.stringify({
              event: "wechat_draft_failed",
              jobId: contentJobId,
              code: publisherError.code,
              message: publisherError.message,
              ambiguous: publisherError.ambiguous,
            }),
          );
          await db.query(
            "UPDATE job_targets SET status = $1, error_code = $2, updated_at = NOW() WHERE job_id = $3 AND target = 'wechat'",
            [
              publisherError.ambiguous ? "manual_review" : "failed",
              publisherError.code,
              contentJobId,
            ],
          );
        }
      }
      await reportDraftTarget("公众号草稿处理已完成", true);
    }
    const browserDraftChannels = deliveryTargets.filter(
      (target) => browserDraftChannelSchema.safeParse(target).success,
    ) as BrowserDraftChannel[];
    for (const browserChannel of browserDraftChannels) {
      const channelName = channelLabels[browserChannel];
      await reportDraftTarget(`正在准备${channelName}草稿上传包`);
      let uploadPackageReady = false;
      const artifact = pipeline.channelArtifacts[browserChannel];
      const current = await db.query(
        "SELECT id, status FROM job_targets WHERE job_id = $1 AND target = $2",
        [contentJobId, browserChannel],
      );
      const artifactReady =
        artifact?.status === "ready" &&
        artifact.article &&
        artifact.html &&
        (browserChannel !== "xiaohongshu" || artifact.note);
      if (current.rows[0]?.status === "queued" && artifactReady) {
        const generatedImageResult = await db.query(
          `SELECT id, metadata
           FROM assets
           WHERE kind = 'image' AND status = 'ready'
             AND metadata->>'contentJobId' = $1
             AND COALESCE(metadata->>'role', '') IN ('cover', 'inline')
             AND (
               COALESCE(metadata->>'role', '') = 'inline'
               OR (
                 $2 = 'xiaohongshu'
                 AND COALESCE(metadata->>'role', '') = 'cover'
                 AND COALESCE(metadata->>'targetChannel', 'xiaohongshu') = 'xiaohongshu'
               )
             )
           ORDER BY CASE WHEN metadata->>'role' = 'cover' THEN 0 ELSE 1 END,
                    created_at ASC
           LIMIT 8`,
          [contentJobId, browserChannel],
        );
        const images = resolveXiaohongshuUploadImages(
          artifact.assets,
          generatedImageResult.rows.map((asset) => ({
            id: asset.id as string,
            url: publicAssetUrl(asset.id as string),
            title:
              asset.metadata?.role === "cover"
                ? `${channelName}封面`
                : `章节结构图：${asset.metadata?.chapterHeading ?? "正文配图"}`,
          })),
        );
        if (!images.length) {
          await db.query(
            `UPDATE job_targets SET status = 'manual_review',
             error_code = 'BROWSER_DRAFT_IMAGES_MISSING', updated_at = NOW()
             WHERE id = $1`,
            [current.rows[0].id],
          );
          await reportDraftTarget(
            `${channelName}图文草稿缺少可上传图片，请在复核页选择图片后重试`,
            true,
          );
        } else {
          const payload = {
            schemaVersion: 2,
            contentJobId,
            channel: browserChannel,
            ...(browserChannel === "xiaohongshu"
              ? { note: artifact.note }
              : {
                  article: {
                    title: artifact.article!.title,
                    description: artifact.article!.description,
                    html: artifact.html!,
                    tags: [
                      ...new Set(
                        [
                          request.primaryTag,
                          ...(request.secondaryTags ?? []),
                          ...(browserChannel === "linkedin"
                            ? ["极客跳动", "软件开发", "数字化转型"]
                            : []),
                        ].filter((tag): tag is string => Boolean(tag)),
                      ),
                    ].slice(0, 5),
                  },
                }),
            images,
            safety: { draftOnly: true, formalPublishForbidden: true },
          };
          const fingerprint = createHash("sha256")
            .update(JSON.stringify(payload))
            .digest("hex");
          const uploadTaskId = randomUUID();
          const uploadOperationId = deterministicOperationId(
            `${request.operationId}:${browserChannel}-upload:v2`,
          );
          await db.query(
            `INSERT INTO xiaohongshu_upload_tasks
           (id, operation_id, content_job_id, target_id, channel, created_by, artifact_version, content_fingerprint, payload, status)
           VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8::jsonb, 'waiting_for_uploader')
           ON CONFLICT (target_id) DO UPDATE SET
             channel = EXCLUDED.channel,
             payload = EXCLUDED.payload,
             content_fingerprint = EXCLUDED.content_fingerprint,
             status = CASE WHEN xiaohongshu_upload_tasks.status = 'drafted' THEN 'drafted' ELSE 'waiting_for_uploader' END,
             error_code = NULL,
             claimed_by_token_id = NULL,
             claim_expires_at = NULL,
             updated_at = NOW()`,
            [
              uploadTaskId,
              uploadOperationId,
              contentJobId,
              current.rows[0].id,
              browserChannel,
              row.created_by,
              fingerprint,
              JSON.stringify(payload),
            ],
          );
          await db.query(
            `UPDATE job_targets SET status = 'waiting_for_uploader', content_fingerprint = $1,
           provider_state = provider_state || $2::jsonb, error_code = NULL, updated_at = NOW()
           WHERE id = $3`,
            [
              fingerprint,
              JSON.stringify({
                uploadTaskId,
                browserChannel,
                draftOnly: true,
                imageCount: images.length,
              }),
              current.rows[0].id,
            ],
          );
          uploadPackageReady = true;
        }
      }
      if (uploadPackageReady)
        await reportDraftTarget(
          `${channelName}上传包已就绪，等待 Chrome 扩展填写并保存草稿`,
          true,
        );
    }

    const targetResult = await db.query(
      "SELECT target, status FROM job_targets WHERE job_id = $1",
      [contentJobId],
    );
    const statuses = targetResult.rows.map((row) => row.status as string);
    const draftedCount = statuses.filter(
      (status) => status === "drafted",
    ).length;
    const waitingForUploader = statuses.some(
      (status) => status === "waiting_for_uploader" || status === "uploading",
    );
    const finalStatus: JobStatus =
      draftedCount === statuses.length
        ? "drafted"
        : waitingForUploader
          ? "awaiting_upload"
          : draftedCount > 0
            ? "partial"
            : statuses.some((status) => status === "manual_review")
              ? "manual_review"
              : "failed";
    const finalMessage =
      finalStatus === "drafted"
        ? "所选渠道草稿已创建"
        : finalStatus === "awaiting_upload"
          ? "内容已生成，等待 Chrome 扩展将所选平台文章保存到草稿箱"
          : finalStatus === "partial"
            ? "部分渠道草稿已创建，可单独重试明确失败的渠道"
            : finalStatus === "manual_review"
              ? "渠道写入结果需要人工复核，系统不会自动重复提交"
              : "草稿创建失败";
    await db.query(
      "UPDATE content_jobs SET status = $1, progress = $2::jsonb, updated_at = NOW() WHERE id = $3 AND status <> 'cancelled'",
      [
        finalStatus,
        JSON.stringify({
          stage: finalStatus,
          percent: 100,
          message: finalMessage,
        }),
        contentJobId,
      ],
    );
    await syncAutomationRunStatus(contentJobId, finalStatus);
    return { jobId: contentJobId, status: finalStatus, contentReady: true };
  },
  { connection, concurrency: 2 },
);

function deterministicOperationId(seed: string) {
  const hex = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function contentFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const dependencyCode = message.match(
    /^(OPENROUTER_HTTP_\d+(?::[A-Z0-9_-]+)?|OPENROUTER_IMAGE_\d+(?::[A-Z0-9_-]+)?|OPENAI_HTTP_\d+(?::[A-Z0-9_-]+)?|OPENAI_IMAGE_\d+(?::[A-Z0-9_-]+)?|OPENAI_IMAGE_[A-Z0-9_-]+|GEEKHOME_HTTP_\d+|GEEKHOME_RPC_[A-Z0-9_-]+|EVIDENCE_OUTPUT_SCHEMA_INVALID|ARTICLE_OUTPUT_SCHEMA_INVALID|OPENAI_RESPONSE_EMPTY_OUTPUT|OPENROUTER_CONTENT_IMAGE_INCOMPLETE|CONTENT_IMAGE_(?:RESIZE|LOGO_OVERLAY)_\d+)/i,
  )?.[1];
  if (dependencyCode) return dependencyCode.toUpperCase();
  if (error instanceof z.ZodError) {
    console.error(
      JSON.stringify({
        event: "content_output_schema_invalid",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      }),
    );
    return "CONTENT_OUTPUT_SCHEMA_INVALID";
  }
  if (error instanceof SyntaxError) return "CONTENT_OUTPUT_JSON_INVALID";
  if (error instanceof Error && error.name === "TimeoutError")
    return "CONTENT_DEPENDENCY_TIMEOUT";
  return "CONTENT_PIPELINE_FAILED";
}

function shanghaiDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

const automationWorker = new Worker(
  env.AUTOMATION_QUEUE_NAME,
  async (job) => {
    const data = z
      .object({
        scheduleId: z.string().uuid(),
        occurrenceKey: z.string().optional(),
        force: z.boolean().optional(),
      })
      .parse(job.data);
    const scheduleResult = await db.query(
      "SELECT * FROM automation_schedules WHERE id = $1",
      [data.scheduleId],
    );
    if (!scheduleResult.rowCount)
      return { skipped: true, reason: "schedule_missing" };
    const schedule = scheduleResult.rows[0];
    if (!schedule.enabled && !data.force)
      return { skipped: true, reason: "schedule_disabled" };
    const occurrenceKey =
      data.occurrenceKey ?? `daily:${shanghaiDate(job.timestamp)}`;
    const operationId = deterministicOperationId(
      `${schedule.id}:${occurrenceKey}`,
    );
    const targets =
      Array.isArray(schedule.template?.targets) &&
      schedule.template.targets.length
        ? schedule.template.targets
        : ["official_site"];
    const input = contentJobRequestSchema.parse({
      ...schedule.template,
      operationId,
      targets,
      confirmDraft: true,
      requireReviewBeforeDraft: true,
    });
    const contentJobId = randomUUID();
    const runId = randomUUID();
    const client = await db.connect();
    let created = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${schedule.id}:${occurrenceKey}`],
      );
      const existingRun = await client.query(
        "SELECT content_job_id FROM automation_schedule_runs WHERE schedule_id = $1 AND occurrence_key = $2",
        [schedule.id, occurrenceKey],
      );
      if (existingRun.rowCount) {
        await client.query("COMMIT");
        return {
          skipped: true,
          reason: "duplicate_occurrence",
          contentJobId: existingRun.rows[0].content_job_id,
        };
      }
      const inserted = await client.query(
        `INSERT INTO content_jobs (id, operation_id, created_by, topic, title, reader_mode, image_mode, status, input)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb) ON CONFLICT (operation_id) DO NOTHING RETURNING id`,
        [
          contentJobId,
          operationId,
          schedule.created_by,
          input.topic,
          input.title ?? null,
          input.readerMode,
          input.imageMode,
          JSON.stringify(input),
        ],
      );
      const resolvedJobId =
        inserted.rows[0]?.id ??
        (
          await client.query(
            "SELECT id FROM content_jobs WHERE operation_id = $1",
            [operationId],
          )
        ).rows[0].id;
      if (inserted.rowCount) {
        for (const target of input.targets) {
          await client.query(
            "INSERT INTO job_targets (id, job_id, target, status) VALUES ($1, $2, $3, 'queued')",
            [randomUUID(), resolvedJobId, target],
          );
        }
        created = true;
      }
      await client.query(
        "INSERT INTO automation_schedule_runs (id, schedule_id, occurrence_key, scheduled_for, status, content_job_id) VALUES ($1, $2, $3, $4, 'queued', $5)",
        [
          runId,
          schedule.id,
          occurrenceKey,
          new Date(job.timestamp),
          resolvedJobId,
        ],
      );
      await client.query(
        "UPDATE automation_schedules SET last_triggered_at = NOW(), last_job_id = $1, updated_at = NOW() WHERE id = $2",
        [resolvedJobId, schedule.id],
      );
      await client.query("COMMIT");
      if (created)
        await contentQueue.add(
          "run-content-pipeline",
          { contentJobId: resolvedJobId },
          {
            jobId: resolvedJobId,
            attempts: 1,
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
      await db.query(
        "UPDATE automation_schedule_runs SET status = 'submitted', updated_at = NOW() WHERE id = $1",
        [runId],
      );
      return { scheduleId: schedule.id, contentJobId: resolvedJobId, created };
    } catch (error) {
      await client.query("ROLLBACK");
      await db
        .query(
          "UPDATE content_jobs SET status = 'failed', error_code = 'SCHEDULE_SUBMIT_FAILED', progress = $1::jsonb, updated_at = NOW() WHERE operation_id = $2 AND status = 'queued'",
          [
            JSON.stringify({
              stage: "failed",
              percent: 0,
              message: "定时任务提交到内容队列失败",
            }),
            operationId,
          ],
        )
        .catch(() => undefined);
      await db
        .query(
          "UPDATE automation_schedule_runs SET status = 'failed', error_code = 'SCHEDULE_SUBMIT_FAILED', updated_at = NOW() WHERE id = $1",
          [runId],
        )
        .catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
  { connection, concurrency: 1 },
);

const imageJobWorker = createImageJobWorker({
  queueName: env.IMAGE_QUEUE_NAME,
  connection,
  db,
  storageDir: env.ASSET_STORAGE_DIR,
  serviceUrl: env.IMAGE_SERVICE_URL,
  providerMode: env.IMAGE_PROVIDER_MODE,
  imageApiKey,
  imageBaseUrl,
  model: imageModel,
  allowedResultHosts: imageAllowedHosts,
  logoPath: env.GEEKDANCE_LOGO_PATH,
  wechatCoverLockupPath: env.WECHAT_COVER_LOCKUP_PATH,
  requireLiveAi: env.NODE_ENV === "production",
  assetStore,
});

worker.on("completed", (job) =>
  console.info(JSON.stringify({ event: "job_completed", jobId: job.id })),
);
worker.on("failed", async (job, error) => {
  const failureCode = contentFailureCode(error);
  console.error(
    JSON.stringify({
      event: "job_failed",
      jobId: job?.id,
      failureCode,
      errorName: error.name,
      // Error messages emitted by the pipeline are stable internal codes. Do
      // not log stack traces, prompts, provider bodies, or credentials.
      errorMessage: error.message.slice(0, 200),
    }),
  );
  const id = job?.data?.contentJobId;
  if (job?.name === imageCandidateJobName && typeof id === "string") {
    await updateImageCandidateGeneration(id, {
      status: "failed",
      completed: 0,
      total: 0,
      errorCode: failureCode,
      message: `插图生成失败（${failureCode}），请稍后重试`,
      failedAt: new Date().toISOString(),
    }).catch(() => undefined);
    return;
  }
  if (typeof id === "string") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE content_jobs SET status = 'failed', error_code = $1, progress = $2::jsonb, updated_at = NOW() WHERE id = $3 AND status <> 'cancelled'",
        [
          failureCode,
          JSON.stringify({
            stage: "failed",
            percent: 0,
            message: `内容任务执行失败（${failureCode}）`,
          }),
          id,
        ],
      );
      await client.query(
        `UPDATE job_targets SET status = 'failed', error_code = $2, updated_at = NOW()
         WHERE job_id = $1 AND status IN ('queued', 'publishing')
         AND EXISTS (SELECT 1 FROM content_jobs WHERE id = $1 AND status <> 'cancelled')`,
        [id, failureCode],
      );
      await client.query(
        `UPDATE automation_schedule_runs
         SET status = 'failed', error_code = $1, updated_at = NOW()
         WHERE content_job_id = $2`,
        [failureCode, id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(
        JSON.stringify({
          event: "job_failure_state_update_failed",
          jobId: job?.id,
          error: error instanceof Error ? error.name : "Error",
        }),
      );
    } finally {
      client.release();
    }
  }
});

async function shutdown() {
  clearInterval(runtimeHeartbeat);
  await worker.close();
  await automationWorker.close();
  await imageJobWorker.close();
  await contentQueue.close();
  await connection.quit();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
