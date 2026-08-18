import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Queue } from "bullmq";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  downloadRemoteImage,
  type OssAssetStore,
} from "@geekdance/channel-adapters";
import {
  imageJobRequestSchema,
  imageRuntimeIssues,
  type SessionUser,
  type WorkerRuntimeSnapshot,
} from "@geekdance/shared";
import { config } from "./config.js";
import { db } from "./database.js";
import { authenticate, requireCsrf } from "./security.js";

const terminalImageStatuses = new Set([
  "completed",
  "manual_review",
  "failed",
  "cancelled",
]);
const safeStorageKey = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/;
const coverTextBlocksSchema = z.object({
  blocks: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(200),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().positive().max(1),
        height: z.number().positive().max(1),
      }),
    )
    .max(40),
});

function responseOutputText(payload: Record<string, any>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (Array.isArray(payload.output) ? payload.output : [])
    .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
    .filter((item: any) => item?.type === "output_text")
    .map((item: any) => String(item.text ?? ""))
    .join("\n");
}

async function sendStoredImage(
  reply: FastifyReply,
  filePath: string,
  storageKey: string,
  mimeType: string,
  visibility: "public" | "private",
  fileSize: number,
) {
  if (config.ASSET_ACCEL_REDIRECT) {
    return reply
      .header(
        "X-Accel-Redirect",
        `/_internal/${visibility}-assets/${storageKey}`,
      )
      .send();
  }
  reply
    .header(
      "Cache-Control",
      visibility === "public"
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
    )
    .header("Content-Length", String(fileSize))
    .header("X-Asset-Delivery", "api-buffer")
    .header("X-Content-Type-Options", "nosniff")
    .type(mimeType);
  return reply.send(await readFile(filePath));
}

function detectImage(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", extension: "jpg" };
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return { mime: "image/png", extension: "png" };
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return { mime: "image/webp", extension: "webp" };
  return null;
}

function signedAssetUrl(assetId: string) {
  if (!config.ASSET_PUBLIC_SECRET) return null;
  const signature = createHmac("sha256", config.ASSET_PUBLIC_SECRET)
    .update(assetId)
    .digest("hex");
  return `/api/public/assets/${assetId}/${signature}`;
}

function assetView(row: Record<string, any>, fileAvailable = true) {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    status: fileAvailable ? row.status : "missing",
    mimeType: row.mime_type,
    metadata: row.metadata,
    fileUrl:
      fileAvailable && row.storage_key
        ? (signedAssetUrl(row.id) ?? `/api/assets/${row.id}/file`)
        : null,
    createdAt: row.created_at,
  };
}

async function storedAssetView(row: Record<string, any>) {
  if (!row.storage_key || !safeStorageKey.test(row.storage_key))
    return assetView(row, false);
  const file = await stat(
    join(config.ASSET_STORAGE_DIR, row.storage_key),
  ).catch(() => null);
  if (file?.isFile()) return assetView(row);
  if (typeof row.has_blob === "boolean") return assetView(row, row.has_blob);
  const backup = await db.query(
    "SELECT 1 FROM asset_blobs WHERE asset_id = $1",
    [row.id],
  );
  return assetView(row, Boolean(backup.rowCount));
}

async function ensureStoredImage(row: Record<string, any>) {
  if (!row.storage_key || !safeStorageKey.test(row.storage_key)) return null;
  const filePath = join(config.ASSET_STORAGE_DIR, row.storage_key);
  const file = await stat(filePath).catch(() => null);
  if (file?.isFile()) return { filePath, fileSize: file.size };
  const backup = await db.query(
    "SELECT bytes FROM asset_blobs WHERE asset_id = $1",
    [row.id],
  );
  const bytes = backup.rows[0]?.bytes as Buffer | undefined;
  if (!bytes?.byteLength) return null;
  await writeFile(filePath, bytes, { mode: 0o644, flag: "wx" }).catch(
    () => undefined,
  );
  return { filePath, fileSize: bytes.byteLength };
}

async function assetStoreUrl(
  assetStore: OssAssetStore | undefined,
  row: Record<string, any>,
  filePath: string,
) {
  if (!assetStore) return null;
  if (row.metadata?.ossBacked !== true) {
    void mirrorAssetToStore(
      assetStore,
      row.id,
      row.storage_key,
      readFile(filePath).then((bytes) => new Uint8Array(bytes)),
      row.mime_type ?? "application/octet-stream",
    );
    return null;
  }
  return assetStore.signedUrl(row.storage_key);
}

async function mirrorAssetToStore(
  assetStore: OssAssetStore,
  assetId: string,
  storageKey: string,
  bytes: Uint8Array | Promise<Uint8Array>,
  mime: string,
) {
  try {
    await assetStore.put(storageKey, await bytes, mime);
    await db.query(
      `UPDATE assets
       SET metadata = metadata || '{"ossBacked":true}'::jsonb
       WHERE id = $1 AND status <> 'deleted'`,
      [assetId],
    );
  } catch {
    // The database blob and local file remain the source of truth. A later
    // asset request will retry the optional OSS mirror without blocking the
    // upload response or making the asset appear missing.
  }
}

function backupAssetBlob(
  assetId: string,
  bytes: Uint8Array,
  onError: (error: unknown) => void,
) {
  void db
    .query(
      "INSERT INTO asset_blobs (asset_id, bytes) VALUES ($1, $2) ON CONFLICT (asset_id) DO UPDATE SET bytes = EXCLUDED.bytes",
      [assetId, Buffer.from(bytes)],
    )
    .catch(onError);
}

async function imageJobView(row: Record<string, any>) {
  const outputIds = Array.isArray(row.output_asset_ids)
    ? row.output_asset_ids
    : [];
  const output = outputIds.length
    ? await db.query(
        "SELECT * FROM assets WHERE id = ANY($1::uuid[]) ORDER BY created_at",
        [outputIds],
      )
    : { rows: [] };
  return {
    id: row.id,
    operationId: row.operation_id,
    operation: row.operation,
    status: row.status,
    input: row.input,
    progress: row.progress,
    model: row.model,
    costCents: row.cost_cents,
    errorCode: row.error_code,
    outputs: await Promise.all(output.rows.map(storedAssetView)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ownedImageJob(jobId: string, user: SessionUser) {
  const result = await db.query("SELECT * FROM image_jobs WHERE id = $1", [
    jobId,
  ]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return user.role === "admin" || row.created_by === user.id ? row : null;
}

export async function registerImageRoutes(
  app: FastifyInstance,
  imageQueue: Queue,
  getWorkerRuntime: () => Promise<WorkerRuntimeSnapshot | null>,
  assetStore?: OssAssetStore,
) {
  await mkdir(config.ASSET_STORAGE_DIR, { recursive: true, mode: 0o750 });

  app.post(
    "/api/assets/:assetId/recognize-cover-text",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const params = z
        .object({ assetId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "INVALID_ASSET_ID" });
      if (!config.OPENAI_API_KEY)
        return reply.code(503).send({
          error: "COVER_TEXT_RECOGNITION_NOT_READY",
          message: "封面文字识别服务尚未配置 OpenAI 文本模型",
        });
      const result = await db.query(
        "SELECT * FROM assets WHERE id = $1 AND kind = 'image' AND status = 'ready'",
        [params.data.assetId],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
      const stored = await ensureStoredImage(row);
      if (!stored)
        return reply.code(409).send({
          error: "ASSET_FILE_MISSING",
          message: "封面原图文件缺失，请重新上传",
        });
      if (stored.fileSize > 10 * 1024 * 1024)
        return reply.code(413).send({
          error: "OCR_IMAGE_TOO_LARGE",
          message: "文字识别图片不能超过 10 MiB，请先压缩后上传",
        });
      const bytes = await readFile(stored.filePath);
      const response = await fetch(
        `${config.OPENAI_BASE_URL.replace(/\/$/, "")}/responses`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.OPENAI_TEXT_MODEL,
            reasoning: { effort: "low" },
            max_output_tokens: 2000,
            input: [
              {
                role: "system",
                content:
                  "你是中文海报 OCR 定位器。只识别图中真实可见的文字，不改写、不补全。返回紧贴每个可编辑文字块的归一化边界框。",
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: 'Return only JSON: {"blocks":[{"text":"原文","x":0.1,"y":0.2,"width":0.3,"height":0.1}]}. x/y are top-left coordinates and every number is between 0 and 1. Merge characters that form one title line or one coherent text block. Ignore logos, watermarks and decorative pseudo-text.',
                  },
                  {
                    type: "input_image",
                    image_url: `data:${row.mime_type ?? "image/png"};base64,${bytes.toString("base64")}`,
                    detail: "high",
                  },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        any
      >;
      if (!response.ok)
        return reply.code(502).send({
          error: "COVER_TEXT_RECOGNITION_FAILED",
          message: `封面文字识别失败（HTTP ${response.status}）`,
        });
      const raw = responseOutputText(payload)
        .replace(/^```(?:json)?\s*/iu, "")
        .replace(/\s*```$/u, "")
        .trim();
      let decoded: unknown = {};
      try {
        decoded = JSON.parse(raw || "{}");
      } catch {
        decoded = {};
      }
      const parsed = coverTextBlocksSchema.safeParse(decoded);
      if (!parsed.success)
        return reply.code(502).send({
          error: "COVER_TEXT_RECOGNITION_INVALID",
          message: "文字识别结果不完整，请重试或换一张更清晰的封面",
        });
      return parsed.data;
    },
  );

  app.get("/api/public/assets/:assetId/:signature", async (request, reply) => {
    const parsed = z
      .object({
        assetId: z.string().uuid(),
        signature: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .safeParse(request.params);
    if (!parsed.success || !config.ASSET_PUBLIC_SECRET)
      return reply.code(404).send({ error: "NOT_FOUND" });
    const expected = createHmac("sha256", config.ASSET_PUBLIC_SECRET)
      .update(parsed.data.assetId)
      .digest();
    const actual = Buffer.from(parsed.data.signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(404).send({ error: "NOT_FOUND" });
    const result = await db.query(
      "SELECT * FROM assets WHERE id = $1 AND kind = 'image' AND status = 'ready'",
      [parsed.data.assetId],
    );
    const row = result.rows[0];
    if (!row?.storage_key || !safeStorageKey.test(row.storage_key))
      return reply.code(404).send({ error: "NOT_FOUND" });
    const stored = await ensureStoredImage(row);
    if (!stored) return reply.code(404).send({ error: "ASSET_FILE_MISSING" });
    const ossUrl = await assetStoreUrl(assetStore, row, stored.filePath);
    if (ossUrl) return reply.redirect(ossUrl);
    return sendStoredImage(
      reply,
      stored.filePath,
      row.storage_key,
      row.mime_type ?? "image/png",
      "public",
      stored.fileSize,
    );
  });

  app.post(
    "/api/assets/upload",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "IMAGE_FILE_REQUIRED" });
      const bytes = new Uint8Array(await file.toBuffer());
      if (
        file.file.truncated ||
        !bytes.byteLength ||
        bytes.byteLength > 20 * 1024 * 1024
      )
        return reply.code(413).send({ error: "IMAGE_TOO_LARGE" });
      const image = detectImage(bytes);
      if (
        !image ||
        !new Set([".png", ".jpg", ".jpeg", ".webp"]).has(
          extname(file.filename).toLowerCase(),
        )
      )
        return reply.code(400).send({ error: "INVALID_IMAGE_FILE" });
      const id = randomUUID();
      const storageKey = `${id}.${image.extension}`;
      await writeFile(join(config.ASSET_STORAGE_DIR, storageKey), bytes, {
        mode: 0o644,
        flag: "wx",
      });
      const result = await db.query(
        `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
       VALUES ($1, $2, 'upload', 'image', 'ready', $3, $4, $5::jsonb) RETURNING *`,
        [
          id,
          request.sessionUser!.id,
          storageKey,
          image.mime,
          JSON.stringify({
            originalName: file.filename.slice(0, 160),
            bytes: bytes.byteLength,
            ossBacked: false,
          }),
        ],
      );
      backupAssetBlob(id, bytes, (error) =>
        request.log.error(
          { error, assetId: id },
          "asset database backup failed",
        ),
      );
      if (assetStore)
        void mirrorAssetToStore(assetStore, id, storageKey, bytes, image.mime);
      return reply.code(201).send({ asset: assetView(result.rows[0]) });
    },
  );

  app.post(
    "/api/assets/import",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const parsed = z
        .object({ url: z.string().url() })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_IMAGE_URL" });
      const sourceUrl = new URL(parsed.data.url);
      let downloaded: Awaited<ReturnType<typeof downloadRemoteImage>>;
      try {
        downloaded = await downloadRemoteImage(parsed.data.url, [
          sourceUrl.hostname,
        ]);
      } catch {
        return reply.code(400).send({
          error: "IMAGE_IMPORT_FAILED",
          message: "原图片无法安全导入内容资产，请重新上传本地图片",
        });
      }
      const image = detectImage(downloaded.buffer);
      if (!image) return reply.code(400).send({ error: "INVALID_IMAGE_FILE" });
      const id = randomUUID();
      const storageKey = `${id}.${image.extension}`;
      await writeFile(
        join(config.ASSET_STORAGE_DIR, storageKey),
        downloaded.buffer,
        { mode: 0o644, flag: "wx" },
      );
      const result = await db.query(
        `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
         VALUES ($1, $2, 'review_import', 'image', 'ready', $3, $4, $5::jsonb) RETURNING *`,
        [
          id,
          request.sessionUser!.id,
          storageKey,
          image.mime,
          JSON.stringify({
            originalName: (
              sourceUrl.pathname.split("/").pop() || "复核原图"
            ).slice(0, 160),
            sourceUrl: downloaded.sourceUrl,
            bytes: downloaded.buffer.byteLength,
            ossBacked: false,
          }),
        ],
      );
      backupAssetBlob(id, downloaded.buffer, (error) =>
        request.log.error(
          { error, assetId: id },
          "imported asset database backup failed",
        ),
      );
      if (assetStore)
        void mirrorAssetToStore(
          assetStore,
          id,
          storageKey,
          downloaded.buffer,
          image.mime,
        );
      return reply.code(201).send({ asset: assetView(result.rows[0]) });
    },
  );

  app.get("/api/assets", { preHandler: [authenticate] }, async (request) => {
    // 素材库属于运营工作区，而不是个人私有空间。所有已登录成员都可在
    // 内容生产、复核和图片工坊中复用同一批图片；删除仍保留所有者/管理员门禁。
    const result = await db.query(
      `SELECT assets.*, EXISTS (
         SELECT 1 FROM asset_blobs WHERE asset_blobs.asset_id = assets.id
       ) AS has_blob
       FROM assets
       WHERE kind = 'image' AND status <> 'deleted'
       ORDER BY created_at DESC LIMIT 500`,
    );
    return { assets: await Promise.all(result.rows.map(storedAssetView)) };
  });

  app.patch(
    "/api/assets/:assetId",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const params = z
        .object({ assetId: z.string().uuid() })
        .safeParse(request.params);
      const body = z
        .object({
          name: z
            .string()
            .trim()
            .min(1, "名称不能为空")
            .max(80, "名称不能超过 80 个字符")
            .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
              message: "名称不能包含控制字符",
            }),
        })
        .safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({
          error: "INVALID_ASSET_NAME",
          message: body.success
            ? "素材编号无效"
            : body.error.issues[0]?.message || "素材名称无效",
        });
      const result = await db.query(
        `UPDATE assets
         SET metadata = metadata || jsonb_build_object(
           'displayName', $2::text,
           'renamedAt', NOW()::text,
           'renamedBy', $3::text
         )
         WHERE id = $1 AND kind = 'image' AND status <> 'deleted'
         RETURNING *`,
        [params.data.assetId, body.data.name, request.sessionUser!.id],
      );
      if (!result.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
      return { asset: await storedAssetView(result.rows[0]) };
    },
  );

  app.get(
    "/api/assets/:assetId/file",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = z
        .object({ assetId: z.string().uuid() })
        .safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_ASSET_ID" });
      const result = await db.query(
        "SELECT * FROM assets WHERE id = $1 AND status <> 'deleted'",
        [parsed.data.assetId],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
      if (!row.storage_key || !safeStorageKey.test(row.storage_key))
        return reply.code(404).send({ error: "ASSET_FILE_MISSING" });
      const stored = await ensureStoredImage(row);
      if (!stored) return reply.code(404).send({ error: "ASSET_FILE_MISSING" });
      const ossUrl = await assetStoreUrl(assetStore, row, stored.filePath);
      if (ossUrl) return reply.redirect(ossUrl);
      return sendStoredImage(
        reply,
        stored.filePath,
        row.storage_key,
        row.mime_type ?? "application/octet-stream",
        "private",
        stored.fileSize,
      );
    },
  );

  app.delete(
    "/api/assets/:assetId",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const parsed = z
        .object({ assetId: z.string().uuid() })
        .safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_ASSET_ID" });
      const result = await db.query(
        "SELECT * FROM assets WHERE id = $1 AND status <> 'deleted'",
        [parsed.data.assetId],
      );
      const row = result.rows[0];
      if (
        !row ||
        (request.sessionUser!.role !== "admin" &&
          row.created_by !== request.sessionUser!.id)
      )
        return reply.code(404).send({ error: "NOT_FOUND" });
      await db.query("UPDATE assets SET status = 'deleted' WHERE id = $1", [
        row.id,
      ]);
      if (row.storage_key && safeStorageKey.test(row.storage_key))
        await unlink(join(config.ASSET_STORAGE_DIR, row.storage_key)).catch(
          () => undefined,
        );
      return { ok: true };
    },
  );

  app.post(
    "/api/image-jobs",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      const parsed = imageJobRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "INVALID_IMAGE_JOB",
          details: parsed.error.flatten().fieldErrors,
        });
      if (config.NODE_ENV === "production") {
        const issues = imageRuntimeIssues(
          await getWorkerRuntime(),
          parsed.data.operation,
        );
        if (issues.length)
          return reply.code(503).send({
            error: "PRODUCTION_RUNTIME_NOT_READY",
            message: issues.map((issue) => issue.message).join("；"),
            issues,
          });
      }
      const existing = await db.query(
        "SELECT * FROM image_jobs WHERE operation_id = $1",
        [parsed.data.operationId],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (
          request.sessionUser!.role !== "admin" &&
          row.created_by !== request.sessionUser!.id
        )
          return reply.code(409).send({ error: "OPERATION_ID_CONFLICT" });
        return { job: await imageJobView(row), idempotentReplay: true };
      }
      if (parsed.data.sourceAssetIds.length) {
        const sources = await db.query(
          "SELECT id, created_by FROM assets WHERE id = ANY($1::uuid[]) AND kind = 'image' AND status = 'ready'",
          [parsed.data.sourceAssetIds],
        );
        if (sources.rows.length !== parsed.data.sourceAssetIds.length)
          return reply.code(400).send({ error: "SOURCE_ASSET_UNAVAILABLE" });
      }
      const active = await db.query(
        "SELECT COUNT(*)::int AS count FROM image_jobs WHERE created_by = $1 AND status IN ('queued','running')",
        [request.sessionUser!.id],
      );
      if (active.rows[0].count >= 3)
        return reply.code(429).send({
          error: "ACTIVE_IMAGE_JOB_LIMIT",
          message: "每名成员最多同时运行 3 个图片任务",
        });
      const id = randomUUID();
      const result = await db.query(
        `INSERT INTO image_jobs (id, operation_id, created_by, operation, status, input)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb) RETURNING *`,
        [
          id,
          parsed.data.operationId,
          request.sessionUser!.id,
          parsed.data.operation,
          JSON.stringify(parsed.data),
        ],
      );
      try {
        await imageQueue.add(
          "run-image-job",
          { imageJobId: id },
          { jobId: id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        );
      } catch (error) {
        await db.query(
          "UPDATE image_jobs SET status = 'failed', error_code = 'QUEUE_SUBMIT_FAILED', progress = $1::jsonb, updated_at = NOW() WHERE id = $2",
          [
            JSON.stringify({
              percent: 100,
              message: "图片任务队列暂时不可用",
            }),
            id,
          ],
        );
        throw error;
      }
      return reply.code(202).send({ job: await imageJobView(result.rows[0]) });
    },
  );

  app.get(
    "/api/image-jobs/:jobId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = z
        .object({ jobId: z.string().uuid() })
        .safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "INVALID_IMAGE_JOB_ID" });
      const row = await ownedImageJob(parsed.data.jobId, request.sessionUser!);
      if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
      return {
        job: await imageJobView(row),
        terminal: terminalImageStatuses.has(row.status),
      };
    },
  );
}
