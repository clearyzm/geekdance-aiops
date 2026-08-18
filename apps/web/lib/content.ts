export type JobStatus =
  | "queued"
  | "researching"
  | "writing"
  | "formatting"
  | "publishing"
  | "awaiting_upload"
  | "awaiting_manual_save"
  | "drafted"
  | "partial"
  | "manual_review"
  | "failed"
  | "cancelled";

export type Channel =
  | "official_site"
  | "wechat"
  | "xiaohongshu"
  | "zhihu"
  | "toutiao"
  | "baijiahao"
  | "linkedin";

export type ArticleImagePlacement =
  | { anchor: "cover" }
  | { anchor: "after_summary" }
  | { anchor: "after_opening"; paragraphIndex: number }
  | { anchor: "before_section"; sectionIndex: number }
  | { anchor: "after_section_heading"; sectionIndex: number }
  | {
      anchor: "after_section_paragraph";
      sectionIndex: number;
      paragraphIndex: number;
    }
  | { anchor: "after_section"; sectionIndex: number }
  | { anchor: "before_observation" }
  | { anchor: "before_conclusion" };

export type ManualReview = {
  id: string;
  contentJobId: string;
  targetId: string;
  target: Channel;
  category: "content_quality" | "delivery_uncertain";
  status:
    "pending" | "approved" | "rejected" | "confirmed_drafted" | "retrying";
  reasonCode?: string | null;
  reason: string;
  reviewNote?: string | null;
  revisionApplied?: boolean;
  externalDraftId?: string | null;
  externalUrl?: string | null;
  job?: {
    id: string;
    title: string;
    status: JobStatus;
    createdBy: { id: string; name?: string | null };
  };
  reviewer?: { id: string; name?: string | null } | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
};

export type ReviewableArticle = {
  title: string;
  description: string;
  opening: string[];
  sections: Array<{
    heading: string;
    paragraphs: string[];
    bullets: string[];
  }>;
  observation: string;
  observationTitle?: string;
  conclusion: string;
  summaryPoints?: [string, string, string];
  cta: string;
  evidenceIds: string[];
};

export type ContentJob = {
  id: string;
  operationId: string;
  topic: string;
  title?: string | null;
  status: JobStatus;
  createdBy: { id: string; name?: string | null };
  canManage: boolean;
  progress: { stage: JobStatus; percent: number; message: string };
  input: {
    operationId: string;
    topic: string;
    title?: string;
    contentType: "general" | "case";
    caseStatus?: "proposal" | "delivered";
    caseVisualTypes?: Array<
      "cover" | "function" | "flow" | "roles" | "architecture"
    >;
    readerMode: "general" | "professional";
    imageMode: "geekhome" | "generated";
    includeGeekHome?: boolean;
    targets: Channel[];
    sourceRefs: string[];
    attachmentIds: string[];
    coverAssetIds?: {
      officialSite?: string;
      wechatWide?: string;
      wechatSquare?: string;
    };
    primaryTag?: string;
    secondaryTags?: string[];
    remarks?: string;
    confirmDraft: boolean;
  };
  inputAttachments: Array<{
    id: string;
    name: string;
    mimeType: string;
    bytes: number;
  }>;
  evidence: Array<{
    id: string;
    title: string;
    url: string;
    sourceType: string;
    claims: string[];
    accessedAt: string;
  }>;
  qaReport: null | {
    passed: boolean;
    score: number;
    revisionCount: number;
    errors: string[];
    warnings: string[];
    dimensions: Record<string, number>;
  };
  templateVersions?: Partial<
    Record<
      Channel,
      {
        channel: Channel;
        skillName: string;
        version: string;
        sourceHash: string;
      }
    >
  >;
  result: null | {
    contentStatus?: "ready" | "blocked";
    manualReviewReason?: string;
    article?: ReviewableArticle;
    channelArticles?: Partial<Record<Channel, ReviewableArticle>>;
    channelArtifacts?: Partial<
      Record<
        Channel,
        {
          status: "ready" | "manual_review";
          reason?: string;
          template: {
            skillName: string;
            version: string;
            sourceHash: string;
          };
          article?: ReviewableArticle;
          html?: string;
          reviewedCoverUrl?: string;
          note?: {
            title: string;
            body: string;
            hashtags: string[];
          };
          assets?: Array<{
            placement?: ArticleImagePlacement;
            selected?: {
              id?: string;
              title?: string;
              url?: string;
            } | null;
          }>;
        }
      >
    >;
    officialSiteHtml?: string;
    wechatHtml?: string;
    xiaohongshuHtml?: string;
    zhihuHtml?: string;
    toutiaoHtml?: string;
    baijiahaoHtml?: string;
    linkedinHtml?: string;
    runtime?: {
      contentEngineMode: "mock" | "mock_geekhome" | "openrouter" | "openai";
      imageProviderMode: "mock" | "openrouter" | "openai";
      textModel: string;
      imageModel: string;
    };
  };
  targets: Array<{
    target: Channel;
    status: string;
    errorCode?: string | null;
    externalDraftId?: string | null;
    externalUrl?: string | null;
    uploadTask?: {
      id: string;
      status:
        | "prepared"
        | "waiting_for_uploader"
        | "uploading"
        | "filled"
        | "drafted"
        | "failed"
        | "ambiguous"
        | "manual_review";
      errorCode?: string | null;
      updatedAt: string;
    } | null;
  }>;
  reviews?: ManualReview[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

export const statusMeta: Record<
  JobStatus,
  { label: string; tone: "neutral" | "red" | "green" | "amber" }
> = {
  queued: { label: "等待执行", tone: "neutral" },
  researching: { label: "资料核验", tone: "red" },
  writing: { label: "文章写作", tone: "red" },
  formatting: { label: "渠道排版", tone: "red" },
  publishing: { label: "写入草稿", tone: "red" },
  awaiting_upload: { label: "等待扩展上传", tone: "amber" },
  awaiting_manual_save: { label: "已上传完成", tone: "amber" },
  drafted: { label: "草稿已创建", tone: "green" },
  partial: { label: "部分成功", tone: "amber" },
  manual_review: { label: "等待人工复核", tone: "amber" },
  failed: { label: "执行失败", tone: "red" },
  cancelled: { label: "已取消", tone: "neutral" },
};

export async function csrfToken() {
  const response = await fetch("/api/auth/csrf", { credentials: "include" });
  if (!response.ok) throw new Error("无法获取安全令牌");
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}
