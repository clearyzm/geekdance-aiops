import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeHtmlImageUrl, downloadRemoteImage } from "./official-site.js";

export type WechatPublisherMode = "off" | "mock" | "live";

export type WechatTokenRecord = { accessToken: string; expiresAt: number };

export type WechatTokenStore = {
  get(): Promise<WechatTokenRecord | null>;
  set(record: WechatTokenRecord, ttlSeconds: number): Promise<void>;
  clear(): Promise<void>;
  withRefreshLock<T>(task: () => Promise<T>): Promise<T>;
};

export type WechatPublisherConfig = {
  mode: WechatPublisherMode;
  allowProduction: boolean;
  appId?: string;
  appSecret?: string;
  apiBaseUrl?: string;
  allowedImageHosts?: string[];
  promoBoardPath: string;
  brandLogoPath?: string;
  contactQrPath?: string;
  author?: string;
  contentSourceUrl?: string;
  tokenStore?: WechatTokenStore;
  fetcher?: typeof fetch;
};

export type WechatDraftInput = {
  operationId: string;
  confirmDraft: boolean;
  title: string;
  digest: string;
  contentHtml: string;
  coverImageUrl?: string;
  coverImageData?: {
    buffer: Uint8Array;
    mime: string;
    crops?: { square: string; wide: string };
  };
  coverCrops?: { square: string; wide: string };
  existingCoverMediaId?: string;
  onCoverUploaded?: (mediaId: string) => Promise<void>;
};

export type WechatDraftResult = {
  id: string;
  status: "draft";
  externalUrl: string;
  contentFingerprint: string;
  coverMediaId: string;
  uploadedImages: string[];
  mock: boolean;
  reconciled?: boolean;
};

export class WechatPublisherError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "WechatPublisherError";
  }
}

export class MemoryWechatTokenStore implements WechatTokenStore {
  private record: WechatTokenRecord | null = null;
  private refreshPromise: Promise<unknown> | null = null;

  async get() {
    return this.record;
  }
  async set(record: WechatTokenRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
  async withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.refreshPromise) await this.refreshPromise;
    const promise = task();
    this.refreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = null;
    }
  }
}

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const tokenErrors = new Set([40014, 42001, 42007, 42009]);
const allowedTags = new Set([
  "section",
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "strong",
  "b",
  "em",
  "i",
  "span",
  "ul",
  "ol",
  "li",
  "blockquote",
  "img",
  "br",
  "a",
]);

function charLength(value: string) {
  return Array.from(value).length;
}

export function validateWechatDraftFields(
  input: Pick<WechatDraftInput, "title" | "digest" | "contentHtml">,
  author = "极客跳动编辑部",
) {
  const errors: string[] = [];
  if (!input.title.trim() || charLength(input.title) > 32)
    errors.push("TITLE_EXCEEDS_32_CHARS");
  if (charLength(author) > 16) errors.push("AUTHOR_EXCEEDS_16_CHARS");
  if (charLength(input.digest) > 128) errors.push("DIGEST_EXCEEDS_128_CHARS");
  if (
    !input.contentHtml.trim() ||
    Buffer.byteLength(input.contentHtml, "utf8") > 2 * 1024 * 1024
  )
    errors.push("CONTENT_INVALID");
  if (errors.length)
    throw new WechatPublisherError(
      "INVALID_WECHAT_FIELDS",
      `公众号字段校验未通过：${errors.join(", ")}`,
    );
}

export function validateWechatDraftHtml(html: string) {
  const errors: string[] = [];
  if (!/data-gd-root=["']article["']/i.test(html))
    errors.push("WECHAT_ROOT_REQUIRED");
  if (
    /<(?:script|style|iframe|object|embed|svg|form|input|button|link|meta)\b/i.test(
      html,
    )
  )
    errors.push("FORBIDDEN_HTML_TAG");
  if (/\son[a-z]+\s*=/i.test(html)) errors.push("EVENT_HANDLER_FORBIDDEN");
  if (
    /(?:href|src)\s*=\s*["']\s*(?:javascript|data|file|vbscript):/i.test(html)
  )
    errors.push("DANGEROUS_PROTOCOL");
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)\b/gi))
    if (!allowedTags.has(match[1]!.toLowerCase()))
      errors.push(`TAG_NOT_ALLOWED:${match[1]!.toLowerCase()}`);
  if (errors.length)
    throw new WechatPublisherError(
      "INVALID_WECHAT_HTML",
      `公众号 HTML 校验未通过：${[...new Set(errors)].join(", ")}`,
    );
  return {
    images: [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(
      (match) => match[1]!,
    ),
  };
}

function normalizeHtml(value: string) {
  return value.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}
function copyArrayBuffer(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export class WechatOfficialPublisher {
  private readonly tokenStore: WechatTokenStore;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: WechatPublisherConfig) {
    this.tokenStore = config.tokenStore ?? new MemoryWechatTokenStore();
    this.fetcher = config.fetcher ?? fetch;
  }

  async health() {
    if (this.config.mode === "off")
      return { status: "not_configured" as const };
    if (this.config.mode === "mock") return { status: "mock" as const };
    try {
      await this.getAccessToken();
      return { status: "healthy" as const };
    } catch {
      return { status: "degraded" as const };
    }
  }

  async diagnose() {
    if (this.config.mode !== "live")
      return {
        ok: this.config.mode === "mock",
        mode: this.config.mode,
        checks: [{ name: "mode", ok: this.config.mode === "mock" }],
      };
    try {
      await this.getAccessToken();
      return {
        ok: true,
        mode: this.config.mode,
        checks: [{ name: "access_token", ok: true }],
      };
    } catch (error) {
      return {
        ok: false,
        mode: this.config.mode,
        checks: [
          {
            name: "access_token",
            ok: false,
            code:
              error instanceof WechatPublisherError
                ? error.code
                : "WECHAT_DIAGNOSTIC_FAILED",
            detail:
              error instanceof Error ? error.message : "微信公众号诊断失败",
          },
        ],
      };
    }
  }

  async createDraft(input: WechatDraftInput): Promise<WechatDraftResult> {
    const author = this.config.author ?? "极客跳动编辑部";
    validateWechatDraftFields(input, author);
    const htmlReport = validateWechatDraftHtml(input.contentHtml);
    const contentFingerprint = sha256(
      JSON.stringify({
        title: input.title,
        digest: input.digest,
        contentHtml: input.contentHtml,
      }),
    );
    if (this.config.mode === "off")
      throw new WechatPublisherError(
        "WECHAT_ADAPTER_DISABLED",
        "公众号适配器未启用",
      );
    if (this.config.mode === "mock")
      return {
        id: `mock-wechat-${input.operationId}`,
        status: "draft",
        externalUrl: "https://mp.weixin.qq.com/",
        contentFingerprint,
        coverMediaId:
          input.existingCoverMediaId ?? `mock-cover-${input.operationId}`,
        uploadedImages: [],
        mock: true,
      };
    if (!this.config.allowProduction || input.confirmDraft !== true)
      throw new WechatPublisherError(
        "WECHAT_DRAFT_NOT_CONFIRMED",
        "公众号生产开关和任务草稿确认必须同时开启",
      );
    if (!this.config.appId || !this.config.appSecret)
      throw new WechatPublisherError(
        "WECHAT_CREDENTIALS_MISSING",
        "公众号 AppID/AppSecret 未配置",
      );

    let coverMediaId = input.existingCoverMediaId;
    if (!coverMediaId) {
      const styledCover = input.coverImageData;
      if (!styledCover)
        throw new WechatPublisherError(
          "WECHAT_COVER_DATA_MISSING",
          "公众号草稿缺少已完成品牌化处理的封面数据",
        );
      const uploaded = await this.uploadPermanentCover(
        styledCover.buffer,
        styledCover.mime,
      );
      coverMediaId = uploaded.mediaId;
      await input.onCoverUploaded?.(coverMediaId);
    }

    const sourceVariants = new Map<string, Set<string>>();
    for (const source of htmlReport.images) {
      const identity =
        source === "/brand/geekdance-promo-board.png"
          ? source
          : decodeHtmlImageUrl(source);
      const variants = sourceVariants.get(identity) ?? new Set<string>();
      variants.add(source);
      sourceVariants.set(identity, variants);
    }
    const uploadedImages = new Map<string, string>();
    for (const source of sourceVariants.keys()) {
      const localBrandPath =
        source === "/brand/geekdance-promo-board.png"
          ? this.config.promoBoardPath
          : source === "/brand/geekdance-logo.png"
            ? this.config.brandLogoPath
            : source === "/brand/geekdance-contact-qr.png"
              ? this.config.contactQrPath
              : undefined;
      const file = localBrandPath
        ? {
            buffer: new Uint8Array(await readFile(localBrandPath)),
            mime: "image/png",
          }
        : await this.downloadWechatImage(source);
      uploadedImages.set(
        source,
        await this.uploadContentImage(file.buffer, file.mime),
      );
    }
    let content = input.contentHtml;
    for (const [source, wechatUrl] of uploadedImages)
      for (const variant of sourceVariants.get(source) ?? [])
        content = content.split(variant).join(wechatUrl);
    const finalSources = validateWechatDraftHtml(content).images;
    const acceptedWechatUrls = new Set(uploadedImages.values());
    if (finalSources.some((source) => !acceptedWechatUrls.has(source)))
      throw new WechatPublisherError(
        "WECHAT_EXTERNAL_IMAGE_REMAINS",
        "公众号正文仍包含未上传的外链图片",
      );

    const article = {
      title: input.title,
      author,
      digest: input.digest,
      content,
      content_source_url:
        this.config.contentSourceUrl ?? "https://www.geekdance.cn",
      thumb_media_id: coverMediaId,
      ...((input.coverImageData?.crops ?? input.coverCrops)
        ? {
            pic_crop_1_1: (input.coverImageData?.crops ?? input.coverCrops)!
              .square,
            pic_crop_235_1: (input.coverImageData?.crops ?? input.coverCrops)!
              .wide,
          }
        : {}),
      need_open_comment: 0,
      only_fans_can_comment: 0,
    };
    try {
      const result = await this.callJson(
        "/cgi-bin/draft/add",
        () => ({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articles: [article] }),
        }),
        "WECHAT_DRAFT_CREATE",
        true,
      );
      const id = String(result.media_id ?? "");
      if (!id)
        throw new WechatPublisherError(
          "WECHAT_DRAFT_RESULT_AMBIGUOUS",
          "微信返回成功但缺少草稿 media_id",
          true,
        );
      return {
        id,
        status: "draft",
        externalUrl: "https://mp.weixin.qq.com/",
        contentFingerprint,
        coverMediaId,
        uploadedImages: [...uploadedImages.values()],
        mock: false,
      };
    } catch (error) {
      if (!(error instanceof WechatPublisherError) || !error.ambiguous)
        throw error;
      const reconciled = await this.findMatchingDraft(article).catch(
        () => null,
      );
      if (reconciled)
        return {
          id: reconciled,
          status: "draft",
          externalUrl: "https://mp.weixin.qq.com/",
          contentFingerprint,
          coverMediaId,
          uploadedImages: [...uploadedImages.values()],
          mock: false,
          reconciled: true,
        };
      throw error;
    }
  }

  private async downloadWechatImage(source: string) {
    if (!/^https:\/\//i.test(source))
      throw new WechatPublisherError(
        "WECHAT_IMAGE_SOURCE_FORBIDDEN",
        "公众号图片仅允许 HTTPS 资源或内置品牌图",
      );
    try {
      const file = await downloadRemoteImage(
        source,
        this.config.allowedImageHosts?.filter(Boolean) ?? [],
      );
      return { buffer: file.buffer, mime: file.mime };
    } catch (error) {
      throw new WechatPublisherError(
        "WECHAT_IMAGE_DOWNLOAD_FAILED",
        error instanceof Error ? error.message : "公众号图片下载失败",
      );
    }
  }

  private async uploadContentImage(buffer: Uint8Array, mime: string) {
    const result = await this.callJson(
      "/cgi-bin/media/uploadimg",
      () => {
        const form = new FormData();
        form.append(
          "media",
          new Blob([copyArrayBuffer(buffer)], { type: mime }),
          `content.${mime === "image/png" ? "png" : "jpg"}`,
        );
        return { method: "POST", body: form };
      },
      "WECHAT_CONTENT_IMAGE_UPLOAD",
      false,
    );
    const url = String(result.url ?? "");
    if (!/^https?:\/\//i.test(url))
      throw new WechatPublisherError(
        "WECHAT_CONTENT_IMAGE_URL_MISSING",
        "微信正文图上传后未返回 URL",
      );
    return url;
  }

  private async uploadPermanentCover(buffer: Uint8Array, mime: string) {
    const result = await this.callJson(
      "/cgi-bin/material/add_material?type=image",
      () => {
        const form = new FormData();
        form.append(
          "media",
          new Blob([copyArrayBuffer(buffer)], { type: mime }),
          `cover.${mime === "image/png" ? "png" : "jpg"}`,
        );
        return { method: "POST", body: form };
      },
      "WECHAT_COVER_UPLOAD",
      true,
    );
    const mediaId = String(result.media_id ?? "");
    if (!mediaId)
      throw new WechatPublisherError(
        "WECHAT_COVER_MEDIA_ID_MISSING",
        "微信封面上传后未返回 media_id",
        true,
      );
    return { mediaId };
  }

  private async findMatchingDraft(article: Record<string, unknown>) {
    const result = await this.callJson(
      "/cgi-bin/draft/batchget",
      () => ({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: 0, count: 20, no_content: 0 }),
      }),
      "WECHAT_DRAFT_RECONCILE",
      false,
    );
    const matches = (Array.isArray(result.item) ? result.item : []).filter(
      (item: Record<string, any>) => {
        const candidate = item.content?.news_item?.[0];
        return (
          candidate?.title === article.title &&
          candidate?.digest === article.digest &&
          normalizeHtml(String(candidate?.content ?? "")) ===
            normalizeHtml(String(article.content ?? ""))
        );
      },
    );
    return matches.length === 1
      ? String(matches[0].media_id ?? "") || null
      : null;
  }

  private async getAccessToken() {
    const cached = await this.tokenStore.get();
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000)
      return cached.accessToken;
    return this.tokenStore.withRefreshLock(async () => {
      const current = await this.tokenStore.get();
      if (current && current.expiresAt > Date.now() + 5 * 60_000)
        return current.accessToken;
      if (!this.config.appId || !this.config.appSecret)
        throw new WechatPublisherError(
          "WECHAT_CREDENTIALS_MISSING",
          "公众号 AppID/AppSecret 未配置",
        );
      const url = new URL(
        `${this.config.apiBaseUrl ?? "https://api.weixin.qq.com"}/cgi-bin/token`,
      );
      url.searchParams.set("grant_type", "client_credential");
      url.searchParams.set("appid", this.config.appId);
      url.searchParams.set("secret", this.config.appSecret);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new WechatPublisherError(
          "WECHAT_TOKEN_UNAVAILABLE",
          `微信 Access Token 获取失败：${error instanceof Error ? error.name : "network"}`,
        );
      }
      const json = (await response.json()) as Record<string, any>;
      if (!response.ok || !json.access_token) {
        const reportedIp =
          typeof json.errmsg === "string"
            ? json.errmsg.match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0]
            : undefined;
        throw new WechatPublisherError(
          "WECHAT_TOKEN_REJECTED",
          `微信 Access Token 获取失败：${json.errcode ?? response.status}${reportedIp ? `（当前出口 IP：${reportedIp}）` : ""}`,
        );
      }
      const expiresIn = Math.max(600, Number(json.expires_in ?? 7200));
      const record = {
        accessToken: String(json.access_token),
        expiresAt: Date.now() + expiresIn * 1000,
      };
      await this.tokenStore.set(record, expiresIn);
      return record.accessToken;
    });
  }

  private async callJson(
    path: string,
    initFactory: () => RequestInit,
    codePrefix: string,
    ambiguousOnNetwork: boolean,
  ) {
    for (let tokenAttempt = 0; tokenAttempt < 2; tokenAttempt += 1) {
      const token = await this.getAccessToken();
      const separator = path.includes("?") ? "&" : "?";
      let response: Response;
      try {
        response = await this.fetcher(
          `${this.config.apiBaseUrl ?? "https://api.weixin.qq.com"}${path}${separator}access_token=${encodeURIComponent(token)}`,
          { ...initFactory(), signal: AbortSignal.timeout(45_000) },
        );
      } catch (error) {
        throw new WechatPublisherError(
          `${codePrefix}_AMBIGUOUS`,
          `${codePrefix} 网络结果不明确：${error instanceof Error ? error.name : "network"}`,
          ambiguousOnNetwork,
        );
      }
      let json: Record<string, any>;
      try {
        json = (await response.json()) as Record<string, any>;
      } catch {
        throw new WechatPublisherError(
          `${codePrefix}_INVALID_RESPONSE`,
          `${codePrefix} 返回了无效 JSON`,
          ambiguousOnNetwork,
        );
      }
      const errcode = Number(json.errcode ?? 0);
      if (tokenErrors.has(errcode) && tokenAttempt === 0) {
        await this.tokenStore.clear();
        continue;
      }
      if (!response.ok || errcode !== 0)
        throw new WechatPublisherError(
          `${codePrefix}_FAILED`,
          `${codePrefix} 失败：${errcode || response.status}`,
          ambiguousOnNetwork && response.status >= 500,
        );
      return json;
    }
    throw new WechatPublisherError(
      `${codePrefix}_TOKEN_FAILED`,
      `${codePrefix} 在刷新 Token 后仍失败`,
    );
  }
}
