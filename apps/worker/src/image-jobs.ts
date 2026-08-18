import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker, type ConnectionOptions } from "bullmq";
import type pg from "pg";
import { imageJobRequestSchema, type ImageJobRequest } from "@geekdance/shared";
import {
  downloadRemoteImage,
  type OssAssetStore,
} from "@geekdance/channel-adapters";
import { replaceCoverTextInRegion } from "./case-diagrams.js";
import {
  applyGeekDanceWechatCoverStyle,
  WECHAT_COVER_CROPS,
  WECHAT_COVER_STYLE_VERSION,
} from "./wechat-cover.js";

type ImageWorkerOptions = {
  queueName: string;
  connection: ConnectionOptions;
  db: pg.Pool;
  storageDir: string;
  serviceUrl: string;
  providerMode: "mock" | "openrouter" | "openai";
  imageApiKey?: string;
  imageBaseUrl: string;
  model: string;
  allowedResultHosts: string[];
  logoPath: string;
  wechatCoverLockupPath: string;
  requireLiveAi: boolean;
  assetStore?: OssAssetStore;
};

export type OpenRouterImageOptions = Pick<
  ImageWorkerOptions,
  "model" | "allowedResultHosts"
> & {
  openRouterApiKey?: string;
  openRouterBaseUrl: string;
  promptOverride?: string;
};

export type AiImageOptions = Pick<
  ImageWorkerOptions,
  | "providerMode"
  | "imageApiKey"
  | "imageBaseUrl"
  | "model"
  | "allowedResultHosts"
> & {
  /** Use a purpose-built prompt without the image-studio scene wrapper. */
  promptOverride?: string;
};

const safeStorageKey = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/;

export function detectGeneratedImage(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: "image/jpeg", extension: "jpg" } as const;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return { mime: "image/png", extension: "png" } as const;
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return { mime: "image/webp", extension: "webp" } as const;
  throw new Error("OPENROUTER_IMAGE_INVALID_CONTENT");
}

function brandPrompt(input: ImageJobRequest) {
  if (input.operation === "compose")
    return `Use reference image 1 as the exact foreground person and reference image 2 as the exact background scene.
Create one natural, photorealistic composite at ${input.ratio}. Automatically choose the person's position, scale and crop by analyzing the background perspective, available negative space, walking/standing surface, light direction and visual balance. If the additional direction explicitly specifies position or size, follow it; otherwise do not force a preset side or percentage.
Preserve the person's identity, face, body proportions, hairstyle, clothing, accessories and pose. Preserve the background's architecture, objects and overall framing.
Blend the cutout into the scene by matching perspective, contact shadow, ambient light, color temperature, edge detail and depth of field. Do not invent or remove people or objects.
Additional direction: ${input.prompt || "natural commercial editorial integration"}.
No text, no logo, no watermark, no UI, no fake data and no third-party branding.`;
  return `Create a ${input.ratio} editorial key visual that depicts this request literally: ${input.prompt}.
Translate the request into one specific, observable business moment with concrete people, objects, environment and action when the request supports them. Use one coherent scene with a clear visual hierarchy, not a collage.
Do not default to a generic robot, glowing sphere, floating icon network, connected cubes, abstract data tunnel or decorative technology background unless explicitly requested.
Use generous title-safe negative space and a premium contemporary commercial composition. Preserve the requested subject placement and business meaning before applying brand styling.
GeekDance visual direction: off-white and warm gray base, charcoal structure, restrained #DA251C red accents, believable materials, refined editorial lighting.
No text, no logo, no watermark, no fake legible UI or metrics, no customer branding and no blue cyberpunk aesthetic.`;
}

function openRouterAspectRatio(ratio: ImageJobRequest["ratio"]) {
  return ratio === "wechat_cover" ? "21:9" : ratio;
}

function imageBlob(bytes: Uint8Array, mime = "image/png") {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}

async function imageService(
  options: ImageWorkerOptions,
  path: string,
  fields: Record<string, string>,
  files: Array<{
    name: string;
    bytes: Uint8Array;
    mime: string;
    filename: string;
  }> = [],
) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files)
    form.append(file.name, imageBlob(file.bytes, file.mime), file.filename);
  const response = await fetch(
    `${options.serviceUrl.replace(/\/$/, "")}${path}`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(
        path === "/remove-background" ? 180_000 : 60_000,
      ),
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string | Array<{ msg?: string }>;
    } | null;
    const detail = Array.isArray(payload?.detail)
      ? payload.detail
          .map((item) => item.msg)
          .filter(Boolean)
          .join("；")
      : payload?.detail;
    const normalized = String(detail || "")
      .toUpperCase()
      .replace(/[^A-Z0-9\u4e00-\u9fff_-]+/gu, "_")
      .slice(0, 80);
    throw new Error(
      `IMAGE_SERVICE_${response.status}${normalized ? `:${normalized}` : ""}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024)
    throw new Error("IMAGE_SERVICE_INVALID_OUTPUT");
  return bytes;
}

// Keep a small global provider concurrency window. A single promise tail made
// every article illustration wait for the previous one, so six high-quality
// images took roughly six provider round trips. Three concurrent requests keep
// image quality unchanged while avoiding an unbounded burst that can trigger
// provider 429s or excessive worker memory use.
const IMAGE_PROVIDER_MAX_CONCURRENCY = 3;
let activeImageProviderRequests = 0;
const imageProviderWaiters: Array<() => void> = [];

async function acquireImageProviderPermit() {
  if (activeImageProviderRequests < IMAGE_PROVIDER_MAX_CONCURRENCY) {
    activeImageProviderRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => imageProviderWaiters.push(resolve));
  activeImageProviderRequests += 1;
}

function releaseImageProviderPermit() {
  activeImageProviderRequests = Math.max(0, activeImageProviderRequests - 1);
  imageProviderWaiters.shift()?.();
}

function providerFailureCode(
  provider: "OPENROUTER" | "OPENAI",
  status: number,
  payload: Record<string, any>,
) {
  const rawCode = String(
    payload.error?.code ?? payload.error?.type ?? payload.error?.name ?? "",
  );
  const code = rawCode
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${provider}_IMAGE_${status}${code ? `:${code}` : ""}`;
}

function openAiImageSize(ratio: ImageJobRequest["ratio"]) {
  switch (ratio) {
    case "wechat_cover":
      return "1536x656";
    case "16:9":
      return "1536x864";
    case "4:3":
      return "1536x1152";
    case "3:4":
      return "1152x1536";
    default:
      return "1024x1024";
  }
}

async function generateOpenAiImagesUnqueued(
  options: AiImageOptions,
  input: ImageJobRequest,
  sourceFiles: Array<{ bytes: Uint8Array; mime: string }>,
) {
  if (!options.imageApiKey) throw new Error("OPENAI_IMAGE_KEY_MISSING");
  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.promptOverride ?? brandPrompt(input),
    n: input.count,
    quality: input.quality === "standard" ? "medium" : "high",
    size: openAiImageSize(input.ratio),
    output_format: "png",
  };
  if (sourceFiles.length)
    body.images = sourceFiles.map((file) => ({
      image_url: `data:${file.mime};base64,${Buffer.from(file.bytes).toString("base64")}`,
    }));
  const endpoint = sourceFiles.length ? "images/edits" : "images/generations";
  const retryable = new Set([429, 500, 502, 503, 504]);
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      response = await fetch(
        `${options.imageBaseUrl.replace(/\/$/, "")}/${endpoint}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.imageApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        },
      );
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          1_000 * 2 ** attempt + Math.floor(Math.random() * 300),
        ),
      );
      continue;
    }
    if (response.ok || !retryable.has(response.status) || attempt === 3) break;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        retryAfter > 0
          ? Math.min(retryAfter * 1_000, 60_000)
          : 5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000),
      ),
    );
  }
  if (!response) throw new Error("OPENAI_IMAGE_NO_RESPONSE");
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok)
    throw new Error(providerFailureCode("OPENAI", response.status, json));
  const outputs = (Array.isArray(json.data) ? json.data : [])
    .slice(0, input.count)
    .flatMap((item: Record<string, unknown>) =>
      typeof item.b64_json === "string"
        ? [new Uint8Array(Buffer.from(item.b64_json, "base64"))]
        : [],
    );
  if (!outputs.length) throw new Error("OPENAI_IMAGE_EMPTY_RESULT");
  for (const output of outputs) detectGeneratedImage(output);
  return { outputs, costCents: 0 };
}

async function generateOpenRouterImagesUnqueued(
  options: OpenRouterImageOptions,
  input: ImageJobRequest,
  sourceFiles: Array<{ bytes: Uint8Array; mime: string }>,
) {
  if (!options.openRouterApiKey) throw new Error("OPENROUTER_API_KEY_MISSING");
  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.promptOverride ?? brandPrompt(input),
    n: input.count,
    quality: input.quality === "standard" ? "medium" : "high",
    aspect_ratio: openRouterAspectRatio(input.ratio),
    resolution: input.quality === "standard" ? "1K" : "2K",
    output_format: "png",
  };
  if (sourceFiles.length)
    body.input_references = sourceFiles.map((file) => ({
      type: "image_url",
      image_url: {
        url: `data:${file.mime};base64,${Buffer.from(file.bytes).toString("base64")}`,
      },
    }));
  const retryable = new Set([429, 500, 502, 503, 504]);
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      response = await fetch(
        `${options.openRouterBaseUrl.replace(/\/$/, "")}/api/v1/images`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.openRouterApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aiops.geekdance.cn",
            "X-Title": "GeekDance AI Operations",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        },
      );
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          1_000 * 2 ** attempt + Math.floor(Math.random() * 300),
        ),
      );
      continue;
    }
    if (response.ok || !retryable.has(response.status) || attempt === 3) break;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        retryAfter > 0
          ? Math.min(retryAfter * 1_000, 60_000)
          : 5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000),
      ),
    );
  }
  if (!response) throw new Error("OPENROUTER_IMAGE_NO_RESPONSE");
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok)
    throw new Error(providerFailureCode("OPENROUTER", response.status, json));
  const data = Array.isArray(json.data) ? json.data : [];
  const outputs: Uint8Array[] = [];
  for (const item of data.slice(0, input.count)) {
    if (typeof item.b64_json === "string")
      outputs.push(new Uint8Array(Buffer.from(item.b64_json, "base64")));
    else if (typeof item.url === "string")
      outputs.push(
        (await downloadRemoteImage(item.url, options.allowedResultHosts))
          .buffer,
      );
  }
  if (!outputs.length) throw new Error("OPENROUTER_IMAGE_EMPTY_RESULT");
  for (const output of outputs) detectGeneratedImage(output);
  return {
    outputs,
    costCents: Math.max(0, Math.round(Number(json.usage?.cost ?? 0) * 100)),
  };
}

/** Keep image provider traffic below burst limits when content workers run in parallel. */
export async function generateOpenRouterImages(
  options: OpenRouterImageOptions,
  input: ImageJobRequest,
  sourceFiles: Array<{ bytes: Uint8Array; mime: string }>,
) {
  return generateAiImages(
    {
      providerMode: "openrouter",
      imageApiKey: options.openRouterApiKey,
      imageBaseUrl: options.openRouterBaseUrl,
      model: options.model,
      allowedResultHosts: options.allowedResultHosts,
      promptOverride: options.promptOverride,
    },
    input,
    sourceFiles,
  );
}

export async function generateAiImages(
  options: AiImageOptions,
  input: ImageJobRequest,
  sourceFiles: Array<{ bytes: Uint8Array; mime: string }>,
) {
  await acquireImageProviderPermit();
  try {
    return options.providerMode === "openai"
      ? await generateOpenAiImagesUnqueued(options, input, sourceFiles)
      : await generateOpenRouterImagesUnqueued(
          {
            openRouterApiKey: options.imageApiKey,
            openRouterBaseUrl: options.imageBaseUrl,
            model: options.model,
            allowedResultHosts: options.allowedResultHosts,
            promptOverride: options.promptOverride,
          },
          input,
          sourceFiles,
        );
  } finally {
    releaseImageProviderPermit();
  }
}

async function loadSources(
  options: ImageWorkerOptions,
  input: ImageJobRequest,
) {
  if (!input.sourceAssetIds.length) return [];
  const result = await options.db.query(
    "SELECT id, storage_key, mime_type FROM assets WHERE id = ANY($1::uuid[]) AND status = 'ready'",
    [input.sourceAssetIds],
  );
  const order = new Map(input.sourceAssetIds.map((id, index) => [id, index]));
  result.rows.sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  if (result.rows.length !== input.sourceAssetIds.length)
    throw new Error("SOURCE_ASSET_MISSING");
  return Promise.all(
    result.rows.map(async (row) => {
      if (!row.storage_key || !safeStorageKey.test(row.storage_key))
        throw new Error("SOURCE_ASSET_STORAGE_INVALID");
      return {
        id: row.id as string,
        bytes: new Uint8Array(
          await readFile(join(options.storageDir, row.storage_key)),
        ),
        mime: String(row.mime_type ?? "image/png"),
      };
    }),
  );
}

async function runOperation(
  options: ImageWorkerOptions,
  input: ImageJobRequest,
  sources: Awaited<ReturnType<typeof loadSources>>,
) {
  if (input.operation === "generate") {
    if (options.providerMode !== "mock") {
      const generated = await generateAiImages(options, input, sources);
      return {
        ...generated,
        outputs: await Promise.all(
          generated.outputs.map((bytes, index) =>
            imageService(
              options,
              "/resize",
              { ratio: input.ratio, output_format: "jpeg" },
              [
                {
                  name: "file",
                  bytes,
                  mime: detectGeneratedImage(bytes).mime,
                  filename: `generated-${index}.png`,
                },
              ],
            ),
          ),
        ),
      };
    }
    const outputs = await Promise.all(
      Array.from({ length: input.count }, () =>
        imageService(options, "/placeholder", {
          ratio: input.ratio,
          prompt: input.prompt ?? "GeekDance business technology",
        }),
      ),
    );
    return { outputs, costCents: 0 };
  }
  const sourceFiles = sources.map((source, index) => ({
    name: "files",
    bytes: source.bytes,
    mime: source.mime,
    filename: `source-${index}.png`,
  }));
  if (input.operation === "remove_background")
    return {
      outputs: [
        await imageService(options, "/remove-background", {}, [
          { ...sourceFiles[0]!, name: "file" },
        ]),
      ],
      costCents: 0,
    };
  if (input.operation === "crop") {
    const region = input.cropRegion!;
    return {
      outputs: [
        await imageService(
          options,
          "/crop",
          {
            ratio: input.ratio,
            x: String(region.x),
            y: String(region.y),
            width: String(region.width),
            height: String(region.height),
          },
          [{ ...sourceFiles[0]!, name: "file" }],
        ),
      ],
      costCents: 0,
    };
  }
  if (input.operation === "resize")
    return {
      outputs: [
        await imageService(options, "/resize", { ratio: input.ratio }, [
          { ...sourceFiles[0]!, name: "file" },
        ]),
      ],
      costCents: 0,
    };
  if (input.operation === "xiaohongshu_cover_text")
    return {
      outputs: [
        new Uint8Array(
          await replaceCoverTextInRegion(
            sources[0]!.bytes,
            input.prompt!,
            input.textRegion!,
          ),
        ),
      ],
      costCents: 0,
    };
  if (input.operation === "wechat_cover_brand") {
    const lockup = new Uint8Array(
      await readFile(options.wechatCoverLockupPath),
    );
    const styled = await applyGeekDanceWechatCoverStyle(
      sources[0]!.bytes,
      lockup,
      sources[0]!.bytes,
      input.wechatCoverRegions,
    );
    return { outputs: [styled.buffer], costCents: 0 };
  }
  if (input.operation === "compose") {
    if (options.providerMode !== "mock") {
      const generated = await generateAiImages(
        options,
        { ...input, count: 1 },
        sources,
      );
      const bytes = generated.outputs[0]!;
      return {
        ...generated,
        outputs: [
          await imageService(
            options,
            "/resize",
            { ratio: input.ratio, output_format: "jpeg" },
            [
              {
                name: "file",
                bytes,
                mime: detectGeneratedImage(bytes).mime,
                filename: "composite.png",
              },
            ],
          ),
        ],
      };
    }
    return {
      outputs: [
        await imageService(
          options,
          "/compose",
          {
            ratio: input.ratio,
            // The mock image service is a deterministic test fallback. Real
            // composition uses the image model above to infer placement from
            // the prompt and both source images.
            position: "center",
            output_format: "jpeg",
          },
          [
            { ...sourceFiles[0]!, name: "foreground" },
            { ...sourceFiles[1]!, name: "background" },
          ],
        ),
      ],
      costCents: 0,
    };
  }
  const placement = input.logoPlacement!;
  return {
    outputs: [
      await imageService(
        options,
        "/overlay",
        {
          x: String(placement.x),
          y: String(placement.y),
          width_ratio: String(placement.width),
        },
        [
          { ...sourceFiles[0]!, name: "file" },
          { ...sourceFiles[1]!, name: "logo" },
        ],
      ),
    ],
    costCents: 0,
  };
}

export function createImageJobWorker(options: ImageWorkerOptions) {
  const worker = new Worker(
    options.queueName,
    async (job) => {
      const imageJobId = String(job.data.imageJobId ?? "");
      const result = await options.db.query(
        "SELECT * FROM image_jobs WHERE id = $1",
        [imageJobId],
      );
      if (!result.rowCount || result.rows[0].status === "cancelled")
        return { skipped: true };
      const row = result.rows[0];
      const input = imageJobRequestSchema.parse(row.input);
      if (
        options.requireLiveAi &&
        ["generate", "compose"].includes(input.operation) &&
        (options.providerMode === "mock" || !options.imageApiKey)
      )
        throw new Error("PRODUCTION_IMAGE_RUNTIME_NOT_READY");
      if (input.operation === "compose" && !input.rightsConfirmed) {
        await options.db.query(
          "UPDATE image_jobs SET status = 'manual_review', error_code = 'SOURCE_RIGHTS_CONFIRMATION_REQUIRED', progress = $1::jsonb, updated_at = NOW() WHERE id = $2",
          [
            JSON.stringify({
              percent: 100,
              message: "AI 图片融合需要确认人物与素材授权",
            }),
            imageJobId,
          ],
        );
        return { status: "manual_review" };
      }
      await options.db.query(
        "UPDATE image_jobs SET status = 'running', progress = $1::jsonb, updated_at = NOW() WHERE id = $2",
        [JSON.stringify({ percent: 20, message: "正在处理图片" }), imageJobId],
      );
      const sources = await loadSources(options, input);
      const operation = await runOperation(options, input, sources);
      const outputAssetIds: string[] = [];
      for (const bytes of operation.outputs) {
        const assetId = randomUUID();
        const format = detectGeneratedImage(bytes);
        const storageKey = `${assetId}.${format.extension}`;
        await writeFile(join(options.storageDir, storageKey), bytes, {
          mode: 0o644,
          flag: "wx",
        });
        await options.assetStore?.put(storageKey, bytes, format.mime);
        await options.db.query(
          `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
           VALUES ($1, $2, $3, 'image', 'ready', $4, $5, $6::jsonb)`,
          [
            assetId,
            row.created_by,
            input.operation === "generate" || input.operation === "compose"
              ? options.providerMode
              : input.operation,
            storageKey,
            format.mime,
            JSON.stringify({
              imageJobId,
              operation: input.operation,
              ratio: input.ratio,
              model:
                input.operation === "generate" || input.operation === "compose"
                  ? options.providerMode === "mock"
                    ? "mock-brand-raster"
                    : options.model
                  : "deterministic-image-worker",
              prompt: input.prompt ?? null,
              sourceAssetIds: input.sourceAssetIds,
              costCents: operation.costCents,
              ossBacked: Boolean(options.assetStore),
              ...(input.operation === "wechat_cover_brand"
                ? {
                    role: "cover",
                    targetChannel: "wechat",
                    wechatCoverStyleVersion: WECHAT_COVER_STYLE_VERSION,
                    derivedFromAssetId: input.sourceAssetIds[0],
                    crops: WECHAT_COVER_CROPS,
                    cropRegions: input.wechatCoverRegions ?? null,
                  }
                : {}),
            }),
          ],
        );
        await options.db.query(
          "INSERT INTO asset_blobs (asset_id, bytes) VALUES ($1, $2) ON CONFLICT (asset_id) DO UPDATE SET bytes = EXCLUDED.bytes",
          [assetId, Buffer.from(bytes)],
        );
        outputAssetIds.push(assetId);
      }
      await options.db.query(
        `UPDATE image_jobs SET status = 'completed', output_asset_ids = $1::jsonb, progress = $2::jsonb, model = $3,
         cost_cents = $4, error_code = NULL, updated_at = NOW() WHERE id = $5`,
        [
          JSON.stringify(outputAssetIds),
          JSON.stringify({ percent: 100, message: "图片处理完成" }),
          options.providerMode === "openrouter" &&
          ["generate", "compose"].includes(input.operation)
            ? options.model
            : "local",
          operation.costCents,
          imageJobId,
        ],
      );
      return { status: "completed", outputAssetIds };
    },
    { connection: options.connection, concurrency: 1 },
  );
  worker.on("failed", async (job, error) => {
    const imageJobId = job?.data?.imageJobId;
    if (typeof imageJobId === "string")
      await options.db
        .query(
          "UPDATE image_jobs SET status = 'failed', error_code = $1, progress = $2::jsonb, updated_at = NOW() WHERE id = $3",
          [
            error.message.slice(0, 120),
            JSON.stringify({
              percent: 100,
              message: "图片任务失败，请检查素材或服务配置",
            }),
            imageJobId,
          ],
        )
        .catch(() => undefined);
  });
  return worker;
}
