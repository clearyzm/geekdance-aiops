import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extname } from "node:path";

export type OfficialPublisherMode = "off" | "mock" | "live";

export type OfficialSiteConfig = {
  mode: OfficialPublisherMode;
  baseUrl: string;
  allowProduction: boolean;
  bearerToken?: string;
  username?: string;
  password?: string;
  uploadDir?: string;
  allowedImageHosts?: string[];
};

export type OfficialDraftInput = {
  operationId: string;
  confirmDraft: boolean;
  title: string;
  description: string;
  contentHtml: string;
  category?: string;
  materialIds?: string[];
  coverImageUrl?: string;
  metadata?: Record<string, unknown>;
};

export type OfficialDraftResult = {
  id: string;
  status: "draft";
  externalUrl?: string;
  contentFingerprint: string;
  uploadedImages: string[];
  mock: boolean;
};

export class OfficialPublisherError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "OfficialPublisherError";
  }
}

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function validateOfficialHtml(html: string) {
  const lower = html.toLowerCase();
  const errors: string[] = [];
  const count = (pattern: RegExp) => html.match(pattern)?.length ?? 0;
  const report = {
    inlineStyles: count(/\sstyle=["'][^"']+["']/gi),
    redTokens: count(/#e52521/gi),
    sections: count(/data-gd-section=["']/gi),
    callouts: count(/data-gd-callout=["']/gi),
    conclusions: count(/data-gd-conclusion=["']/gi),
    headings: count(/<h2\b/gi),
    root: /data-gd-root=["']website-article["']/i.test(html),
  };
  if (html.length > 2 * 1024 * 1024) errors.push("HTML_EXCEEDS_2_MIB");
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
  if (/<h1\b/i.test(html)) errors.push("H1_FORBIDDEN");
  const hasWechatPromotionBoard =
    /geekdance-promo-board|gd-promo/i.test(lower) ||
    ["关于我们", "联系方式", "主营业务"].every((label) =>
      lower.includes(label),
    );
  if (hasWechatPromotionBoard)
    errors.push("WECHAT_PROMOTION_FORBIDDEN");
  if (report.inlineStyles < 12) errors.push("INLINE_STYLES_REQUIRED");
  if (report.redTokens < 4) errors.push("BRAND_RED_REQUIRED");
  if (report.sections < 3 || report.headings < 3)
    errors.push("WEBSITE_SECTIONS_REQUIRED");
  if (report.callouts < 1 || report.conclusions < 1 || !report.root)
    errors.push("WEBSITE_STRUCTURE_REQUIRED");
  if (errors.length)
    throw new OfficialPublisherError(
      "INVALID_OFFICIAL_HTML",
      `官网排版门禁未通过：${errors.join(", ")}`,
    );
  return report;
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  )
    return true;
  if (!isIP(normalized) || normalized.includes(":")) return false;
  const octets = normalized.split(".").map(Number);
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 0
  );
}

function hostAllowed(hostname: string, allowed: string[]) {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/^\*\./, ".");
    return rule.startsWith(".")
      ? host.endsWith(rule) && host !== rule.slice(1)
      : host === rule;
  });
}

async function validateRemoteUrl(rawUrl: string, allowedHosts: string[]) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:")
    throw new OfficialPublisherError(
      "IMAGE_URL_FORBIDDEN",
      "图片仅允许 HTTPS 地址",
    );
  if (!hostAllowed(url.hostname, allowedHosts))
    throw new OfficialPublisherError(
      "IMAGE_HOST_FORBIDDEN",
      "图片域名不在允许列表",
    );
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw new OfficialPublisherError(
      "IMAGE_ADDRESS_FORBIDDEN",
      "图片地址解析到受保护网络",
    );
  return url;
}

function validImageMagic(bytes: Uint8Array) {
  const b = bytes;
  return (
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
    (String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.slice(8, 12)) === "WEBP") ||
    String.fromCharCode(...b.slice(0, 6)).startsWith("GIF8")
  );
}

export async function downloadRemoteImage(
  rawUrl: string,
  allowedHosts: string[],
) {
  let url = await validateRemoteUrl(rawUrl, allowedHosts);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "image/*" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === 3)
        throw new OfficialPublisherError(
          "IMAGE_REDIRECT_FORBIDDEN",
          "图片跳转次数过多或缺少目标地址",
        );
      url = await validateRemoteUrl(
        new URL(location, url).toString(),
        allowedHosts,
      );
      continue;
    }
    if (!response.ok)
      throw new OfficialPublisherError(
        "IMAGE_DOWNLOAD_FAILED",
        `图片下载失败：HTTP ${response.status}`,
      );
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 10 * 1024 * 1024)
      throw new OfficialPublisherError("IMAGE_TOO_LARGE", "图片超过 10 MiB");
    const mime = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .toLowerCase();
    if (
      !new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]).has(mime)
    )
      throw new OfficialPublisherError(
        "IMAGE_MIME_FORBIDDEN",
        "图片 MIME 类型不受支持",
      );
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 10 * 1024 * 1024 || !validImageMagic(buffer))
      throw new OfficialPublisherError(
        "IMAGE_CONTENT_INVALID",
        "图片文件内容无效",
      );
    return { buffer, mime, sourceUrl: url.toString() };
  }
  throw new OfficialPublisherError("IMAGE_DOWNLOAD_FAILED", "图片下载失败");
}

export function decodeHtmlImageUrl(value: string) {
  return value.replace(/&(?:amp|#38|#x26);/gi, "&");
}

function extensionForMime(mime: string) {
  return (
    (
      {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
      } as Record<string, string>
    )[mime] ?? ".jpg"
  );
}

function contentFingerprint(input: OfficialDraftInput) {
  return sha256(
    JSON.stringify({
      title: input.title,
      description: input.description,
      contentHtml: input.contentHtml,
      materialIds: input.materialIds ?? [],
    }),
  );
}

function buildPayload(
  input: OfficialDraftInput,
  contentHtml: string,
  coverImage: string,
  fingerprint: string,
) {
  const now = new Date();
  const publishDate = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  return {
    locales: {
      "zh-CN": {
        locale: "zh-CN",
        title: input.title,
        description: input.description,
        content: contentHtml,
        detailSectionTitles: {
          content: "正文",
          background: "背景",
          challenge: "挑战",
          solution: "方案",
        },
      },
    },
    shared: {
      category: input.category ?? "AI 技术",
      authorId: "0",
      authorName: "极客跳动",
      publishDate,
      coverImage,
      seoImage: coverImage,
      status: "draft",
    },
    translationMeta: {
      source: "geekdance-ai-ops",
      operationId: input.operationId,
      contentFingerprint: fingerprint,
      materialIds: input.materialIds ?? [],
      ...(input.metadata ?? {}),
    },
  };
}

export class OfficialSitePublisher {
  private bearer = "";
  private configuredBearerRejected = false;
  constructor(private readonly config: OfficialSiteConfig) {}

  async health() {
    if (this.config.mode === "off")
      return { status: "not_configured" as const };
    if (this.config.mode === "mock") return { status: "mock" as const };
    try {
      const response = await fetch(this.config.baseUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(8_000),
      });
      return {
        status: response.ok ? ("healthy" as const) : ("degraded" as const),
        httpStatus: response.status,
      };
    } catch {
      return { status: "unreachable" as const };
    }
  }

  async diagnose() {
    if (this.config.mode !== "live")
      return {
        ok: this.config.mode === "mock",
        mode: this.config.mode,
        checks: [{ name: "mode", ok: this.config.mode === "mock" }],
      };
    const checks: Array<{ name: string; ok: boolean; status?: number }> = [];
    try {
      const base = new URL(this.config.baseUrl);
      if (
        base.protocol !== "https:" ||
        base.hostname === "localhost" ||
        isPrivateAddress(base.hostname)
      )
        throw new Error("invalid base URL");
      const response = await fetch(base, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      checks.push({
        name: "base",
        ok: response.status >= 200 && response.status < 500,
        status: response.status,
      });
    } catch {
      checks.push({ name: "base", ok: false });
    }
    try {
      const bearer = await this.resolveBearer();
      checks.push({ name: "authentication", ok: Boolean(bearer) });
      const articles = await fetch(
        `${this.config.baseUrl.replace(/\/$/, "")}/admin/articles`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${bearer}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      checks.push({
        name: "draft_endpoint",
        ok: articles.ok,
        status: articles.status,
      });
    } catch {
      checks.push({ name: "authentication", ok: false });
    }
    try {
      const signature = await this.uploadSignature(
        `${this.config.uploadDir ?? "ai-generated/blogs"}/diagnostics`,
        1024 * 1024,
      );
      const data = signature.data ?? signature;
      checks.push({
        name: "media_signature",
        ok: Boolean(data.host && data.policy),
      });
    } catch {
      checks.push({ name: "media_signature", ok: false });
    }
    return {
      ok: checks.every((check) => check.ok),
      mode: this.config.mode,
      checks,
    };
  }

  async createDraft(input: OfficialDraftInput): Promise<OfficialDraftResult> {
    validateOfficialHtml(input.contentHtml);
    const fingerprint = contentFingerprint(input);
    if (this.config.mode === "off")
      throw new OfficialPublisherError(
        "OFFICIAL_ADAPTER_DISABLED",
        "官网适配器未启用",
      );
    if (this.config.mode === "mock")
      return {
        id: `mock-${input.operationId}`,
        status: "draft",
        contentFingerprint: fingerprint,
        uploadedImages: [],
        mock: true,
      };
    if (!this.config.allowProduction || input.confirmDraft !== true)
      throw new OfficialPublisherError(
        "PRODUCTION_DRAFT_NOT_CONFIRMED",
        "官网生产开关和任务草稿确认必须同时开启",
      );
    const base = new URL(this.config.baseUrl);
    if (
      base.protocol !== "https:" ||
      isPrivateAddress(base.hostname) ||
      base.hostname === "localhost"
    )
      throw new OfficialPublisherError(
        "OFFICIAL_BASE_URL_FORBIDDEN",
        "生产官网地址必须是公网 HTTPS",
      );

    const allowedHosts = this.config.allowedImageHosts?.filter(Boolean) ?? [];
    const imageSourceVariants = new Map<string, Set<string>>();
    const registerImageSource = (value: string | undefined) => {
      if (!value) return;
      const remoteUrl = decodeHtmlImageUrl(value);
      const variants = imageSourceVariants.get(remoteUrl) ?? new Set<string>();
      variants.add(value);
      imageSourceVariants.set(remoteUrl, variants);
    };
    registerImageSource(input.coverImageUrl);
    for (const match of input.contentHtml.matchAll(
      /<img\b[^>]*\bsrc=["'](https:\/\/[^"']+)["']/gi,
    ))
      registerImageSource(match[1]);
    const uploaded = new Map<string, string>();
    for (const source of imageSourceVariants.keys())
      uploaded.set(source, await this.uploadImage(source, allowedHosts));
    let contentHtml = input.contentHtml;
    for (const [source, officialUrl] of uploaded) {
      for (const variant of imageSourceVariants.get(source) ?? [])
        contentHtml = contentHtml.split(variant).join(officialUrl);
    }
    const coverImage = input.coverImageUrl
      ? (uploaded.get(decodeHtmlImageUrl(input.coverImageUrl)) ?? "")
      : (uploaded.values().next().value ?? "");
    const payload = buildPayload(input, contentHtml, coverImage, fingerprint);
    let bearer = "";
    let response: Response | undefined;
    let json: Record<string, any> | undefined;
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      bearer = await this.resolveBearer();
      try {
        response = await fetch(
          `${this.config.baseUrl.replace(/\/$/, "")}/admin/articles`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        throw new OfficialPublisherError(
          "OFFICIAL_WRITE_AMBIGUOUS",
          `官网草稿请求结果不明确：${error instanceof Error ? error.name : "network"}`,
          true,
        );
      }
      try {
        json = (await response.json()) as Record<string, any>;
      } catch {
        throw new OfficialPublisherError(
          "OFFICIAL_WRITE_AMBIGUOUS",
          `官网草稿接口返回了无效响应：HTTP ${response.status}`,
          true,
        );
      }
      if (
        authAttempt === 0 &&
        this.canRefreshBearer() &&
        this.authenticationRejected(response, json)
      ) {
        this.invalidateBearer();
        continue;
      }
      break;
    }
    if (!response || !json)
      throw new OfficialPublisherError(
        "OFFICIAL_WRITE_AMBIGUOUS",
        "官网草稿接口未返回结果",
        true,
      );
    if (!response.ok || Number(json.code) !== 200)
      throw new OfficialPublisherError(
        response.status >= 500
          ? "OFFICIAL_WRITE_AMBIGUOUS"
          : "OFFICIAL_DRAFT_CREATE_FAILED",
        `官网草稿创建失败：${json.message ?? response.status}`,
        response.status >= 500,
      );
    const id = String(json.data?.id ?? "");
    if (!id)
      throw new OfficialPublisherError(
        "OFFICIAL_WRITE_AMBIGUOUS",
        "官网返回成功但缺少草稿 ID",
        true,
      );
    await this.saveBatch(id, payload, bearer);
    return {
      id,
      status: "draft",
      externalUrl: `${this.config.baseUrl.replace(/\/$/, "")}/system/#/cms/content/articles/edit/${encodeURIComponent(id)}`,
      contentFingerprint: fingerprint,
      uploadedImages: [...uploaded.values()],
      mock: false,
    };
  }

  private async resolveBearer() {
    if (this.config.bearerToken && !this.configuredBearerRejected)
      return this.config.bearerToken;
    if (this.bearer) return this.bearer;
    if (!this.config.username || !this.config.password)
      throw new OfficialPublisherError(
        "OFFICIAL_AUTH_MISSING",
        "官网草稿账号未配置",
      );
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, "")}/admin/auth/password/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const json = (await response.json()) as Record<string, any>;
    if (!response.ok || Number(json.code) !== 200 || !json.data?.token)
      throw new OfficialPublisherError(
        "OFFICIAL_AUTH_FAILED",
        `官网草稿账号登录失败：${json.message ?? response.status}`,
      );
    this.bearer = String(json.data.token);
    return this.bearer;
  }

  private canRefreshBearer() {
    return Boolean(this.config.username && this.config.password);
  }

  private invalidateBearer() {
    this.bearer = "";
    if (this.config.bearerToken) this.configuredBearerRejected = true;
  }

  private authenticationRejected(
    response: Response,
    json: Record<string, any>,
  ) {
    return response.status === 401 || Number(json.code) === 401;
  }

  private async uploadImage(source: string, allowedHosts: string[]) {
    if (!allowedHosts.length)
      throw new OfficialPublisherError(
        "IMAGE_ALLOWLIST_EMPTY",
        "官网图片允许域名尚未配置",
      );
    const file = await downloadRemoteImage(source, allowedHosts);
    const now = new Date();
    const uploadDir = `${this.config.uploadDir ?? "ai-generated/blogs"}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
    const objectName = `${Date.now()}-${sha256(file.buffer).slice(0, 12)}${extname(new URL(source).pathname) || extensionForMime(file.mime)}`;
    const signature = await this.uploadSignature(
      uploadDir,
      file.buffer.byteLength,
    );
    const data = signature.data ?? signature;
    const objectKey = `${String(data.dir ?? uploadDir).replace(/\/?$/, "/")}${objectName}`;
    const form = new FormData();
    form.append("key", objectKey);
    form.append("policy", data.policy);
    form.append(
      "x-oss-signature-version",
      data.xOssSignatureVersion ??
        data.x_oss_signature_version ??
        "OSS4-HMAC-SHA256",
    );
    form.append(
      "x-oss-credential",
      data.xOssCredential ?? data.x_oss_credential,
    );
    form.append("x-oss-date", data.xOssDate ?? data.x_oss_date);
    form.append("x-oss-signature", data.xOssSignature ?? data.x_oss_signature);
    if (data.xOssSecurityToken ?? data.x_oss_security_token)
      form.append(
        "x-oss-security-token",
        data.xOssSecurityToken ?? data.x_oss_security_token,
      );
    form.append(
      "file",
      new Blob([file.buffer], { type: file.mime }),
      objectName,
    );
    const uploadResponse = await fetch(data.host, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    if (!uploadResponse.ok && uploadResponse.status !== 204)
      throw new OfficialPublisherError(
        "OFFICIAL_MEDIA_UPLOAD_FAILED",
        `官网图片上传失败：HTTP ${uploadResponse.status}`,
      );
    const publicUrl = `${String(data.publicHost ?? data.public_host ?? data.host).replace(/\/$/, "")}/${objectKey}`;
    let registerResponse: Response | undefined;
    let registered: Record<string, any> | undefined;
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      const bearer = await this.resolveBearer();
      registerResponse = await fetch(
        `${this.config.baseUrl.replace(/\/$/, "")}/admin/media`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: publicUrl,
            name: objectName,
            type: "image",
            category: "AI官网博客",
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      registered = (await registerResponse.json()) as Record<string, any>;
      if (
        authAttempt === 0 &&
        this.canRefreshBearer() &&
        this.authenticationRejected(registerResponse, registered)
      ) {
        this.invalidateBearer();
        continue;
      }
      break;
    }
    if (!registerResponse || !registered)
      throw new OfficialPublisherError(
        "OFFICIAL_MEDIA_REGISTER_FAILED",
        "官网媒体登记未返回结果",
      );
    if (!registerResponse.ok || Number(registered.code) !== 200)
      throw new OfficialPublisherError(
        "OFFICIAL_MEDIA_REGISTER_FAILED",
        `官网媒体登记失败：${registered.message ?? registerResponse.status}`,
      );
    return publicUrl;
  }

  private async uploadSignature(uploadDir: string, size: number) {
    let lastError = "";
    for (const path of ["/api/storage/post-signature", "/api/oss/token"]) {
      try {
        const response = await fetch(
          `${this.config.baseUrl.replace(/\/$/, "")}${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              uploadDir,
              expireTime: 3600,
              maxSize: Math.max(size + 1024, 1024 * 1024),
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        const json = (await response.json()) as Record<string, any>;
        if (response.ok && Number(json.code) === 200) return json;
        lastError = `${path}: ${json.message ?? response.status}`;
      } catch (error) {
        lastError = `${path}: ${error instanceof Error ? error.name : "network"}`;
      }
    }
    throw new OfficialPublisherError(
      "OFFICIAL_MEDIA_SIGNATURE_FAILED",
      `官网图片签名获取失败：${lastError}`,
    );
  }

  private async saveBatch(
    id: string,
    payload: Record<string, any>,
    bearer: string,
  ) {
    let currentBearer = bearer;
    let response: Response | undefined;
    let json: Record<string, any> | undefined;
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      try {
        response = await fetch(
          `${this.config.baseUrl.replace(/\/$/, "")}/admin/articles/${encodeURIComponent(id)}/batch`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${currentBearer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id,
              locales: payload.locales,
              shared: { ...payload.shared, status: "draft" },
              translationMeta: payload.translationMeta,
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        throw new OfficialPublisherError(
          "OFFICIAL_BATCH_SAVE_AMBIGUOUS",
          `官网草稿批量保存结果不明确：${error instanceof Error ? error.name : "network"}`,
          true,
        );
      }
      try {
        json = (await response.json()) as Record<string, any>;
      } catch {
        throw new OfficialPublisherError(
          "OFFICIAL_BATCH_SAVE_AMBIGUOUS",
          `官网草稿批量保存返回无效响应：HTTP ${response.status}`,
          true,
        );
      }
      if (
        authAttempt === 0 &&
        this.canRefreshBearer() &&
        this.authenticationRejected(response, json)
      ) {
        this.invalidateBearer();
        currentBearer = await this.resolveBearer();
        continue;
      }
      break;
    }
    if (!response || !json)
      throw new OfficialPublisherError(
        "OFFICIAL_BATCH_SAVE_AMBIGUOUS",
        "官网草稿批量保存未返回结果",
        true,
      );
    if (!response.ok || Number(json.code) !== 200)
      throw new OfficialPublisherError(
        "OFFICIAL_BATCH_SAVE_AMBIGUOUS",
        `官网草稿批量保存结果不明确：${json.message ?? response.status}`,
        true,
      );
  }
}
