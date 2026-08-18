import { z } from "zod";

export const userRoleSchema = z.enum(["admin", "operator"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "researching",
  "writing",
  "formatting",
  "publishing",
  "awaiting_upload",
  "awaiting_manual_save",
  "drafted",
  "partial",
  "manual_review",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const channelSchema = z.enum([
  "official_site",
  "wechat",
  "xiaohongshu",
  "zhihu",
  "toutiao",
  "baijiahao",
  "linkedin",
]);
export type Channel = z.infer<typeof channelSchema>;

export const browserDraftChannelSchema = z.enum([
  "xiaohongshu",
  "zhihu",
  "toutiao",
  "baijiahao",
  "linkedin",
]);
export type BrowserDraftChannel = z.infer<typeof browserDraftChannelSchema>;

export const channelLabels: Record<Channel, string> = {
  official_site: "官网",
  wechat: "公众号",
  xiaohongshu: "小红书",
  zhihu: "知乎文章",
  toutiao: "今日头条",
  baijiahao: "百家号",
  linkedin: "LinkedIn",
};

const sourceRefSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "参考链接必须使用 HTTPS",
  });

export const caseVisualTypeSchema = z.enum([
  "cover",
  "function",
  "flow",
  "roles",
  "architecture",
]);
export type CaseVisualType = z.infer<typeof caseVisualTypeSchema>;

export const wechatEndingSchema = z.object({
  about: z.string().trim().min(10).max(500),
  slogan: z.string().trim().min(4).max(80),
  phone: z.string().trim().min(5).max(40),
  website: z.string().trim().min(3).max(120),
  address: z.string().trim().min(5).max(160),
  services: z.array(z.string().trim().min(2).max(80)).min(1).max(6),
  recommendations: z
    .array(
      z.object({
        title: z.string().trim().min(2).max(80),
        url: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:"),
      }),
    )
    .max(3),
});
export type WechatEnding = z.infer<typeof wechatEndingSchema>;

export const contentJobRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    topic: z.string().trim().min(2).max(300),
    title: z.string().trim().max(120).optional(),
    contentType: z.enum(["general", "case"]).default("general"),
    caseStatus: z.enum(["proposal", "delivered"]).optional(),
    caseVisualTypes: z
      .array(caseVisualTypeSchema)
      .max(5)
      .refine(
        (items) => new Set(items).size === items.length,
        "案例配图不能重复",
      )
      .optional(),
    readerMode: z.enum(["general", "professional"]),
    sourceRefs: z
      .array(sourceRefSchema)
      .max(20)
      .refine(
        (items) => new Set(items).size === items.length,
        "参考链接不能重复",
      )
      .default([]),
    attachmentIds: z
      .array(z.string().uuid())
      .max(10)
      .refine((items) => new Set(items).size === items.length, "附件不能重复")
      .default([]),
    coverAssetIds: z
      .object({
        officialSite: z.string().uuid().optional(),
        wechatWide: z.string().uuid().optional(),
        wechatSquare: z.string().uuid().optional(),
      })
      .optional(),
    requireReviewBeforeDraft: z.boolean().default(false),
    wechatEnding: wechatEndingSchema.optional(),
    targets: z
      .array(channelSchema)
      .min(1)
      .max(7)
      .refine((items) => new Set(items).size === items.length, "渠道不能重复"),
    imageMode: z.enum(["geekhome", "generated"]),
    includeGeekHome: z.boolean().default(false),
    primaryTag: z.string().trim().max(40).optional(),
    secondaryTags: z
      .array(z.string().trim().max(40))
      .max(10)
      .refine((items) => new Set(items).size === items.length, "标签不能重复")
      .optional(),
    remarks: z.string().trim().max(2_000).optional(),
    confirmDraft: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const titleLength = Array.from(value.title ?? "").length;
    if (value.targets.includes("xiaohongshu") && titleLength > 20)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "小红书标题最多 20 个字符",
      });
    else if (
      (value.targets.includes("toutiao") ||
        value.targets.includes("baijiahao")) &&
      titleLength > 30
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "今日头条和百家号标题最多 30 个字符",
      });
    else if (value.targets.includes("wechat") && titleLength > 32)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "公众号标题最多 32 个字符",
      });
    if (value.contentType !== "case") return;
    if (value.targets.length !== 1 || value.targets[0] !== "xiaohongshu")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "案例模式 V1 仅支持小红书草稿渠道",
      });
    if (!value.caseStatus)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caseStatus"],
        message: "案例模式必须说明是方案型案例还是已交付案例",
      });
    if (value.imageMode !== "generated")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["imageMode"],
        message: "案例模式必须使用案例图表生成",
      });
    const visualTypes = value.caseVisualTypes ?? [];
    if (!visualTypes.includes("cover"))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caseVisualTypes"],
        message: "案例配图必须包含封面",
      });
    if (!visualTypes.some((item) => item !== "cover"))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caseVisualTypes"],
        message: "案例配图至少包含一张项目图",
      });
    if (!value.attachmentIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachmentIds"],
        message: "案例模式必须上传 PRD、商务方案或验收材料作为事实依据",
      });
  });
export type ContentJobRequest = z.infer<typeof contentJobRequestSchema>;

export const workerRuntimeSnapshotSchema = z.object({
  release: z.string().min(1).max(128),
  recordedAt: z.string().datetime(),
  contentEngineMode: z.enum(["mock", "mock_geekhome", "openrouter", "openai"]),
  imageProviderMode: z.enum(["mock", "openrouter", "openai"]),
  officialPublisherMode: z.enum(["off", "mock", "live"]),
  officialAllowProduction: z.boolean(),
  wechatPublisherMode: z.enum(["off", "mock", "live"]),
  wechatAllowProduction: z.boolean(),
  textModel: z.string(),
  imageModel: z.string(),
  textKeyConfigured: z.boolean(),
  imageKeyConfigured: z.boolean(),
  geekHomeConfigured: z.boolean(),
  assetPublicSecretConfigured: z.boolean(),
});
export type WorkerRuntimeSnapshot = z.infer<typeof workerRuntimeSnapshotSchema>;

export type RuntimeIssue = { code: string; message: string };

export function contentRuntimeIssues(
  runtime: WorkerRuntimeSnapshot | null,
  request: Pick<ContentJobRequest, "targets" | "imageMode"> & {
    includeGeekHome?: boolean;
    contentType?: ContentJobRequest["contentType"];
  },
): RuntimeIssue[] {
  if (!runtime)
    return [
      {
        code: "WORKER_OFFLINE",
        message: "内容 Worker 未连接或运行状态已过期",
      },
    ];
  const issues: RuntimeIssue[] = [];
  if (!new Set(["openrouter", "openai"]).has(runtime.contentEngineMode))
    issues.push({
      code: "CONTENT_ENGINE_NOT_LIVE",
      message: "内容引擎尚未启用正式 AI 文本服务",
    });
  if (!runtime.textKeyConfigured)
    issues.push({
      code: "TEXT_API_KEY_MISSING",
      message:
        runtime.contentEngineMode === "openai"
          ? "OpenAI 官方 API 密钥尚未生效"
          : "OpenRouter 文本密钥尚未生效",
    });
  if (
    (request.imageMode === "geekhome" || request.includeGeekHome) &&
    !runtime.geekHomeConfigured
  )
    issues.push({
      code: "GEEKHOME_NOT_CONFIGURED",
      message: "GeekHome 素材连接尚未配置完整",
    });
  if (request.imageMode === "generated") {
    if (!new Set(["openrouter", "openai"]).has(runtime.imageProviderMode))
      issues.push({
        code: "IMAGE_ENGINE_NOT_LIVE",
        message: "AI 生图尚未启用正式图片服务",
      });
    if (!runtime.imageKeyConfigured)
      issues.push({
        code: "IMAGE_API_KEY_MISSING",
        message:
          runtime.imageProviderMode === "openai"
            ? "OpenAI 官方图片密钥尚未生效"
            : "OpenRouter 图片密钥尚未生效",
      });
    if (!runtime.assetPublicSecretConfigured)
      issues.push({
        code: "ASSET_PUBLIC_SECRET_MISSING",
        message: "AI 配图公开签名密钥尚未配置",
      });
  }
  if (request.targets.includes("official_site")) {
    if (runtime.officialPublisherMode !== "live")
      issues.push({
        code: "OFFICIAL_PUBLISHER_NOT_LIVE",
        message: "官网草稿适配器尚未启用正式模式",
      });
    if (!runtime.officialAllowProduction)
      issues.push({
        code: "OFFICIAL_DRAFT_SWITCH_OFF",
        message: "官网生产草稿开关尚未开启",
      });
  }
  if (request.targets.includes("wechat")) {
    if (runtime.wechatPublisherMode !== "live")
      issues.push({
        code: "WECHAT_PUBLISHER_NOT_LIVE",
        message: "公众号草稿适配器尚未启用正式模式",
      });
    if (!runtime.wechatAllowProduction)
      issues.push({
        code: "WECHAT_DRAFT_SWITCH_OFF",
        message: "公众号生产草稿开关尚未开启",
      });
  }
  return issues;
}

export function imageRuntimeIssues(
  runtime: WorkerRuntimeSnapshot | null,
  operation: ImageOperation,
): RuntimeIssue[] {
  if (!runtime)
    return [
      {
        code: "WORKER_OFFLINE",
        message: "图片 Worker 未连接或运行状态已过期",
      },
    ];
  if (!["generate", "compose"].includes(operation)) return [];
  const issues: RuntimeIssue[] = [];
  if (!new Set(["openrouter", "openai"]).has(runtime.imageProviderMode))
    issues.push({
      code: "IMAGE_ENGINE_NOT_LIVE",
      message: "该 AI 图片功能尚未启用正式图片服务",
    });
  if (!runtime.imageKeyConfigured)
    issues.push({
      code: "IMAGE_API_KEY_MISSING",
      message:
        runtime.imageProviderMode === "openai"
          ? "OpenAI 官方图片密钥尚未生效"
          : "OpenRouter 图片密钥尚未生效",
    });
  return issues;
}

export const automationScheduleRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  enabled: z.boolean().default(false),
  cronExpression: z
    .string()
    .trim()
    .regex(
      /^(?:[0-5]?\d) (?:[01]?\d|2[0-3]) \* \* \*$/,
      "必须是每日单一时间（00:00–23:59）",
    )
    .default("0 8 * * *"),
  timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
  template: z.object({
    topic: z.string().trim().min(2).max(300),
    title: z.string().trim().max(120).optional(),
    readerMode: z.enum(["general", "professional"]).default("general"),
    sourceRefs: z
      .array(sourceRefSchema)
      .max(20)
      .refine(
        (items) => new Set(items).size === items.length,
        "参考链接不能重复",
      )
      .default([]),
    imageMode: z.enum(["geekhome", "generated"]).default("generated"),
    includeGeekHome: z.boolean().default(false),
    primaryTag: z.string().trim().max(40).optional(),
    secondaryTags: z
      .array(z.string().trim().max(40))
      .max(10)
      .refine((items) => new Set(items).size === items.length, "标签不能重复")
      .optional(),
    remarks: z.string().trim().max(2_000).optional(),
    targets: z
      .array(channelSchema)
      .min(1)
      .max(7)
      .refine((items) => new Set(items).size === items.length, "渠道不能重复")
      .default(["official_site"]),
  }),
});
export type AutomationScheduleRequest = z.infer<
  typeof automationScheduleRequestSchema
>;

export const imageOperationSchema = z.enum([
  "generate",
  "remove_background",
  "crop",
  "compose",
  "resize",
  "logo_overlay",
  "xiaohongshu_cover_text",
  "wechat_cover_brand",
]);
export type ImageOperation = z.infer<typeof imageOperationSchema>;

export const imageRatioSchema = z.enum([
  "1:1",
  "3:4",
  "4:5",
  "4:3",
  "16:9",
  "wechat_cover",
]);
export type ImageRatio = z.infer<typeof imageRatioSchema>;

export const imageJobRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    operation: imageOperationSchema,
    prompt: z.string().trim().max(2_000).optional(),
    sourceAssetIds: z.array(z.string().uuid()).max(8).default([]),
    cropRegion: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().positive().max(1),
        height: z.number().positive().max(1),
      })
      .refine((region) => region.x + region.width <= 1.000001, {
        message: "裁剪区域超出图片右侧边界",
      })
      .refine((region) => region.y + region.height <= 1.000001, {
        message: "裁剪区域超出图片底部边界",
      })
      .optional(),
    wechatCoverRegions: z
      .object({
        wide: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().positive().max(1),
            height: z.number().positive().max(1),
          })
          .refine((region) => region.x + region.width <= 1.000001, {
            message: "公众号首图裁剪区域超出右侧边界",
          })
          .refine((region) => region.y + region.height <= 1.000001, {
            message: "公众号首图裁剪区域超出底部边界",
          })
          .optional(),
        square: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().positive().max(1),
            height: z.number().positive().max(1),
          })
          .refine((region) => region.x + region.width <= 1.000001, {
            message: "公众号次图裁剪区域超出右侧边界",
          })
          .refine((region) => region.y + region.height <= 1.000001, {
            message: "公众号次图裁剪区域超出底部边界",
          })
          .optional(),
      })
      .optional(),
    ratio: imageRatioSchema.default("16:9"),
    count: z.number().int().min(1).max(4).default(1),
    quality: z.enum(["standard", "high"]).default("high"),
    logoPlacement: z
      .object({
        x: z.number().min(0).max(0.97),
        y: z.number().min(0).max(0.97),
        width: z.number().min(0.03).max(0.6),
      })
      .refine((placement) => placement.x + placement.width <= 1.000001, {
        message: "Logo 超出图片右侧边界",
      })
      .optional(),
    textRegion: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().positive().max(1),
        height: z.number().positive().max(1),
      })
      .refine((region) => region.x + region.width <= 1.000001, {
        message: "文字区域超出图片右侧边界",
      })
      .refine((region) => region.y + region.height <= 1.000001, {
        message: "文字区域超出图片底部边界",
      })
      .optional(),
    detectedText: z.string().trim().max(200).optional(),
    rightsConfirmed: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const count = value.sourceAssetIds.length;
    if (new Set(value.sourceAssetIds).size !== count)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceAssetIds"],
        message: "源素材不能重复",
      });
    if (value.operation === "generate" && count !== 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceAssetIds"],
        message: "普通生图不接受源素材",
      });
    if (
      [
        "remove_background",
        "crop",
        "resize",
        "xiaohongshu_cover_text",
        "wechat_cover_brand",
      ].includes(value.operation) &&
      count !== 1
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceAssetIds"],
        message: "该操作必须选择一张素材",
      });
    if (value.operation === "crop" && !value.cropRegion)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cropRegion"],
        message: "手动裁剪必须提供裁剪区域",
      });
    if (value.operation === "compose" && count !== 2)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceAssetIds"],
        message: "人物背景合成必须依次选择透明人物和背景图",
      });
    if (value.operation === "logo_overlay" && count !== 2)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceAssetIds"],
        message: "Logo 叠加必须依次选择底图和 Logo 图片",
      });
    if (
      ["generate", "xiaohongshu_cover_text"].includes(value.operation) &&
      !value.prompt
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "AI 图片任务必须填写提示词",
      });
    if (value.operation === "logo_overlay" && !value.logoPlacement)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["logoPlacement"],
        message: "请在预览图上确认 Logo 位置和大小",
      });
    if (value.operation === "xiaohongshu_cover_text" && !value.textRegion)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["textRegion"],
        message: "请先识别并选中需要修改的封面文字区域",
      });
  });
export type ImageJobRequest = z.infer<typeof imageJobRequestSchema>;

export const evidenceItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  url: z.string().url(),
  sourceType: z.enum([
    "primary",
    "authoritative",
    "internal",
    "user_attachment",
    "mock",
  ]),
  claims: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
  accessedAt: z.string().datetime(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const articleSectionSchema = z.object({
  heading: z.string(),
  paragraphs: z.array(z.string()).min(1),
  bullets: z.array(z.string()).default([]),
});

export const coreArticleSchema = z.object({
  title: z.string(),
  description: z.string(),
  opening: z.array(z.string()).min(2),
  sections: z.array(articleSectionSchema).min(3).max(5),
  observationTitle: z.string().trim().min(1).max(40).optional(),
  observation: z.string(),
  conclusion: z.string(),
  summaryPoints: z
    .array(z.string().trim().min(1).max(120))
    .length(3)
    .optional(),
  cta: z.string(),
  evidenceIds: z.array(z.string()),
});
export type CoreArticle = z.infer<typeof coreArticleSchema>;

export const articleImagePlacementSchema = z.discriminatedUnion("anchor", [
  z.object({ anchor: z.literal("cover") }),
  z.object({ anchor: z.literal("after_summary") }),
  z.object({
    anchor: z.literal("after_opening"),
    paragraphIndex: z.number().int().min(0).max(20),
  }),
  z.object({
    anchor: z.literal("before_section"),
    sectionIndex: z.number().int().min(0).max(10),
  }),
  z.object({
    anchor: z.literal("after_section_heading"),
    sectionIndex: z.number().int().min(0).max(10),
  }),
  z.object({
    anchor: z.literal("after_section_paragraph"),
    sectionIndex: z.number().int().min(0).max(10),
    paragraphIndex: z.number().int().min(0).max(100),
  }),
  z.object({
    anchor: z.literal("after_section"),
    sectionIndex: z.number().int().min(0).max(10),
  }),
  z.object({ anchor: z.literal("before_observation") }),
  z.object({ anchor: z.literal("before_conclusion") }),
]);
export type ArticleImagePlacement = z.infer<typeof articleImagePlacementSchema>;

export const xiaohongshuNoteSchema = z.object({
  title: z.string().trim().min(2).max(20),
  body: z.string().trim().min(50).max(1_000),
  hashtags: z
    .array(z.string().trim().min(1).max(20))
    .min(1)
    // Operations keeps a stable GeekDance/business topic set and may prepend
    // up to four article-specific topics. The renderer and extension both
    // support twelve, so the shared contract must not reject artifacts that
    // the content engine intentionally produces.
    .max(12)
    .refine((items) => new Set(items).size === items.length, "话题不能重复"),
});
export type XiaohongshuNote = z.infer<typeof xiaohongshuNoteSchema>;

export const xiaohongshuUploadStatusSchema = z.enum([
  "prepared",
  "waiting_for_uploader",
  "uploading",
  "filled",
  "drafted",
  "failed",
  "ambiguous",
  "manual_review",
]);
export type XiaohongshuUploadStatus = z.infer<
  typeof xiaohongshuUploadStatusSchema
>;
export const browserDraftUploadStatusSchema = xiaohongshuUploadStatusSchema;
export type BrowserDraftUploadStatus = XiaohongshuUploadStatus;

export type ChannelTemplateRef = {
  channel: Channel;
  skillName: string;
  version: string;
  sourceHash: string;
};

export type StoredChannelArtifact = {
  status: "ready" | "manual_review";
  template: ChannelTemplateRef;
  article?: CoreArticle;
  html?: string;
  note?: XiaohongshuNote;
  assets?: Array<Record<string, unknown>>;
  qaReport?: QaReport;
  reason?: string;
};

export type QaReport = {
  passed: boolean;
  revisionCount: number;
  score: number;
  dimensions: Record<string, number>;
  errors: string[];
  warnings: string[];
  websiteLayout?: Record<string, number | boolean>;
  wechatLayout?: Record<string, number | boolean>;
  xiaohongshuLayout?: Record<string, number | boolean>;
};

export type ContentJobDetail = {
  id: string;
  operationId: string;
  topic: string;
  title?: string;
  status: JobStatus;
  progress: { stage: JobStatus; percent: number; message: string };
  input: ContentJobRequest;
  evidence: EvidenceItem[];
  qaReport: QaReport | null;
  templateVersions: Partial<Record<Channel, ChannelTemplateRef>>;
  result: {
    contentStatus?: "ready" | "blocked";
    article?: CoreArticle;
    channelArticles?: Partial<Record<Channel, CoreArticle>>;
    channelArtifacts?: Partial<Record<Channel, StoredChannelArtifact>>;
    templateVersions?: Partial<Record<Channel, ChannelTemplateRef>>;
    officialSiteHtml?: string;
    wechatHtml?: string;
    xiaohongshuHtml?: string;
    zhihuHtml?: string;
    toutiaoHtml?: string;
    baijiahaoHtml?: string;
    linkedinHtml?: string;
    assets?: Array<Record<string, unknown>>;
    manualReviewReason?: string;
  } | null;
  targets: Array<{
    target: Channel;
    status: string;
    errorCode?: string | null;
    externalDraftId?: string | null;
    externalUrl?: string | null;
    uploadTask?: {
      id: string;
      status: XiaohongshuUploadStatus;
      errorCode?: string | null;
      updatedAt: string;
    } | null;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type ResearchAttachment = {
  id: string;
  name: string;
  mimeType: string;
  extractedText?: string;
  dataUrl?: string;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  mustChangePassword: boolean;
};
