"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  Globe2,
  Hash,
  ImagePlus,
  Laptop,
  Maximize2,
  MessageCircleMore,
  RotateCcw,
  StopCircle,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import {
  ManualReviewEditor,
  type ReviewAsset,
  type ReviewDraft,
  type WechatCoverCropTarget,
} from "@/components/manual-review-editor";
import type {
  CropRatio,
  CropRegion,
} from "@/components/manual-review-crop-dialog";
import {
  csrfToken,
  type ArticleImagePlacement,
  type Channel,
  type ContentJob,
  statusMeta,
} from "@/lib/content";

const terminal = new Set([
  "drafted",
  "partial",
  "manual_review",
  "awaiting_manual_save",
  "failed",
  "cancelled",
]);
const REQUIRED_XHS_EXTENSION_VERSION = "1.4.0";
const channelNames: Record<Channel, string> = {
  official_site: "官网",
  wechat: "公众号",
  xiaohongshu: "小红书",
  zhihu: "知乎文章",
  toutiao: "今日头条",
  baijiahao: "百家号",
  linkedin: "LinkedIn",
};
const browserDraftChannels = [
  "xiaohongshu",
  "zhihu",
  "toutiao",
  "baijiahao",
  "linkedin",
] as const;

function storedChannelHtml(job: ContentJob, channel: Channel) {
  const artifact = job.result?.channelArtifacts?.[channel];
  if (channel === "official_site")
    return job.result?.officialSiteHtml ?? artifact?.html;
  if (channel === "wechat") return job.result?.wechatHtml ?? artifact?.html;
  if (channel === "xiaohongshu")
    return job.result?.xiaohongshuHtml ?? artifact?.html;
  if (channel === "zhihu") return job.result?.zhihuHtml ?? artifact?.html;
  if (channel === "toutiao") return job.result?.toutiaoHtml ?? artifact?.html;
  if (channel === "baijiahao")
    return job.result?.baijiahaoHtml ?? artifact?.html;
  if (channel === "linkedin")
    return job.result?.linkedinHtml ?? artifact?.html;
  return artifact?.html;
}

function isExtensionVersionAtLeast(current: string, required: string) {
  const parse = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10));
  const currentParts = parse(current);
  const requiredParts = parse(required);
  if (
    currentParts.some((part) => !Number.isFinite(part)) ||
    requiredParts.some((part) => !Number.isFinite(part))
  )
    return false;
  const length = Math.max(currentParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0;
    const requiredPart = requiredParts[index] || 0;
    if (currentPart > requiredPart) return true;
    if (currentPart < requiredPart) return false;
  }
  return true;
}

function escapePreviewAttribute(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char]!,
  );
}

function formatInputBytes(bytes: number) {
  if (!bytes) return "大小未知";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function optimizeWechatCoverUpload(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const maximumDimension = 2400;
    const scale = Math.min(
      1,
      maximumDimension / Math.max(bitmap.width, bitmap.height),
    );
    if (file.size <= 3 * 1024 * 1024 && scale === 1) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("浏览器无法处理这张封面图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob?.size) throw new Error("封面图片压缩失败，请更换图片后重试");
    const baseName = file.name.replace(/\.[^.]+$/u, "").slice(0, 120);
    return new File([blob], `${baseName || "wechat-cover"}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

function serializeReviewImages(images: ReviewDraft["images"]) {
  return images.flatMap<
    | {
        source: "existing";
        url: string;
        placement?: ArticleImagePlacement;
      }
    | {
        source: "asset";
        assetId: string;
        placement?: ArticleImagePlacement;
      }
    | {
        source: "suggestion";
        materialId: string;
        url: string;
        placement?: ArticleImagePlacement;
      }
  >((image) =>
    image?.source === "existing"
      ? [
          {
            source: "existing",
            url: image.url,
            placement: image.placement,
          },
        ]
      : image?.source === "asset"
        ? [
            {
              source: "asset",
              assetId: image.assetId,
              placement: image.placement,
            },
          ]
        : image?.source === "suggestion"
          ? [
              {
                source: "suggestion",
                materialId: image.materialId,
                url: image.url,
                placement: image.placement,
              },
            ]
          : [],
  );
}

function serializeReviewCover(cover: ReviewDraft["cover"]) {
  return serializeReviewImages(cover ? [cover] : [])[0];
}

type ImageSuggestion = {
  source: "generated" | "geekhome" | "upload";
  assetId?: string;
  materialId: string;
  title: string;
  url: string;
  description?: string;
  role?: "cover" | "inline";
  chapterHeading?: string;
  usageCount: number;
  copyright: string;
};

type ImageSuggestionGeneration = {
  status: "queued" | "running" | "completed" | "failed";
  completed: number;
  total: number;
  message: string;
  errorCode?: string;
};

type ImageSuggestionPayload = {
  suggestions?: ImageSuggestion[];
  message?: string;
  warning?: string;
  generation?: ImageSuggestionGeneration | null;
};

function SmartImagePanel({
  suggestions,
  loading,
  error,
  warning,
  generation,
  filter,
  canInsert,
  busy,
  startingGeneration,
  onFilterChange,
  onUpload,
  onGenerate,
  onInsert,
  selectedKeys,
  onToggleSelected,
  onInsertSelected,
  onUseAsCover,
  hasSelectedCover,
  onZoom,
}: {
  suggestions: ImageSuggestion[];
  loading: boolean;
  error: string;
  warning: string;
  generation: ImageSuggestionGeneration | null;
  filter: "all" | "generated" | "geekhome" | "upload";
  canInsert: boolean;
  busy: boolean;
  startingGeneration: boolean;
  onFilterChange: (filter: "all" | "generated" | "geekhome" | "upload") => void;
  onUpload: (file: File) => void;
  onGenerate: () => void;
  onInsert: (suggestion: ImageSuggestion) => void;
  selectedKeys: Set<string>;
  onToggleSelected: (suggestion: ImageSuggestion) => void;
  onInsertSelected: () => void;
  onUseAsCover: () => void;
  hasSelectedCover: boolean;
  onZoom: (url: string) => void;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const visibleSuggestions = suggestions.filter(
    (suggestion) => filter === "all" || suggestion.source === filter,
  );
  const selectedCount = selectedKeys.size;
  return (
    <Card className="min-w-0 p-4">
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#fff1f2] text-[#e60012]">
          <ImagePlus size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold">智能配图</h3>
          <p className="mt-1 text-xs leading-5 text-[#73737c]">
            上传或选择候选图，再插入当前正文位置。
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => uploadInput.current?.click()}
          disabled={busy}
          className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#dedee3] bg-white px-3 text-xs font-semibold text-[#55555d] hover:border-[#e60012] disabled:opacity-50"
        >
          <Upload size={14} />
          上传
        </button>
        <input
          ref={uploadInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.target.value = "";
          }}
        />
        {!suggestions.some(
          (suggestion) => suggestion.source === "generated",
        ) && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={
              startingGeneration ||
              generation?.status === "queued" ||
              generation?.status === "running"
            }
            className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#17171a] px-3 text-xs font-semibold text-white hover:bg-[#e60012] disabled:cursor-wait disabled:opacity-55"
          >
            <WandSparkles size={14} />
            {generation?.status === "queued" || generation?.status === "running"
              ? "生成中"
              : generation?.status === "failed"
                ? "重试生成"
                : "生成插图"}
          </button>
        )}
        {selectedCount > 0 && (
          <>
            <button
              type="button"
              disabled={!canInsert || busy}
              onClick={onInsertSelected}
              className="focus-ring inline-flex h-9 items-center rounded-lg bg-[#17171a] px-3 text-xs font-semibold text-white hover:bg-[#e60012] disabled:opacity-45"
            >
              插入正文（{selectedCount}）
            </button>
            <button
              type="button"
              disabled={!canInsert || busy || selectedCount !== 1}
              onClick={onUseAsCover}
              className="focus-ring inline-flex h-9 items-center rounded-lg border border-[#e60012] bg-white px-3 text-xs font-semibold text-[#b90012] disabled:border-[#dedee3] disabled:text-[#aaaab1]"
            >
              设为当前渠道封面
            </button>
          </>
        )}
      </div>

      <div className="mt-3 flex gap-1 overflow-x-auto rounded-lg bg-[#f4f4f6] p-1">
        {(
          [
            ["all", "全部"],
            ["generated", "AI 插图"],
            ["geekhome", "GeekHome"],
            ["upload", "上传图片"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onFilterChange(value)}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-semibold ${filter === value ? "bg-white text-[#17171a] shadow-sm" : "text-[#73737c] hover:text-[#17171a]"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {generation &&
        ["queued", "running", "failed"].includes(generation.status) && (
          <div
            className={`mt-3 rounded-lg border p-3 text-xs ${generation.status === "failed" ? "border-[#f3c4c8] bg-[#fff5f5] text-[#a60010]" : "border-[#dfe4eb] bg-[#f8fafc] text-[#55555d]"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span>{generation.message}</span>
              {generation.total > 0 && (
                <strong className="shrink-0">
                  {generation.completed}/{generation.total}
                </strong>
              )}
            </div>
          </div>
        )}
      {error && (
        <p className="mt-3 rounded-lg bg-[#fff5f5] p-3 text-xs leading-5 text-[#a60010]">
          {error}
        </p>
      )}
      {warning && (
        <p className="mt-3 rounded-lg border border-[#f0d9a8] bg-[#fffaf0] p-3 text-xs leading-5 text-[#8a5a00]">
          {warning}
        </p>
      )}
      {hasSelectedCover && (
        <p className="mt-3 rounded-lg border border-[#cfe6d7] bg-[#f2fbf5] p-3 text-xs font-semibold text-[#17693d]">
          当前渠道已选择独立封面；预览确认后随复核稿保存。
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3">
        {loading &&
          [0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="h-48 animate-pulse rounded-xl bg-[#f1f1f3]"
            />
          ))}
        {!loading &&
          visibleSuggestions.map((suggestion) => (
            <article
              key={`${suggestion.materialId}-${suggestion.url}`}
              className={`min-w-0 overflow-hidden rounded-xl border border-[#e5e5e9] bg-white ${suggestion.source === "generated" ? "col-span-2" : ""}`}
            >
              <label className="flex cursor-pointer items-center gap-2 border-b border-[#ededf0] px-3 py-2 text-[11px] font-semibold text-[#55555d]">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(
                    `${suggestion.materialId}\n${suggestion.url}`,
                  )}
                  onChange={() => onToggleSelected(suggestion)}
                  className="h-4 w-4 accent-[#e60012]"
                />
                选择此图
              </label>
              <button
                type="button"
                onClick={() => onZoom(suggestion.url)}
                className="group relative block w-full overflow-hidden bg-[#f4f4f5]"
                aria-label={`放大查看 ${suggestion.title}`}
              >
                <img
                  src={suggestion.url}
                  alt={suggestion.title}
                  loading="lazy"
                  className={`w-full transition group-hover:scale-[1.02] ${suggestion.source === "generated" ? "aspect-video bg-[#fffdfc] object-contain" : "aspect-[4/3] object-cover"}`}
                />
                <span className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg bg-[#17171a]/80 text-white opacity-100 backdrop-blur transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100">
                  <Maximize2 size={14} />
                </span>
              </button>
              <div className="p-3">
                <p className="text-[10px] font-semibold text-[#85858e]">
                  {suggestion.source === "generated"
                    ? "AI 章节插图"
                    : suggestion.source === "geekhome"
                      ? "GeekHome 素材"
                      : "上传图片"}
                </p>
                <p className="mt-1 line-clamp-2 min-h-10 text-xs font-semibold leading-5 text-[#3f3f46]">
                  {suggestion.title}
                </p>
                <button
                  type="button"
                  disabled={!canInsert}
                  onClick={() => onInsert(suggestion)}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center whitespace-nowrap rounded-lg bg-[#17171a] px-3 text-xs font-semibold text-white hover:bg-[#e60012] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  插入正文
                </button>
              </div>
            </article>
          ))}
        {!loading && !visibleSuggestions.length && !error && (
          <p className="col-span-2 grid min-h-28 place-items-center rounded-xl border border-dashed border-[#dedee3] bg-[#fafafa] text-xs text-[#85858e]">
            当前分类暂无可用候选图
          </p>
        )}
      </div>
    </Card>
  );
}

export default function TaskDetailPage() {
  const params = useParams<{ jobId: string }>();
  const router = useRouter();
  const [job, setJob] = useState<ContentJob | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [preview, setPreview] = useState<Channel>("official_site");
  const [startingXiaohongshu, setStartingXiaohongshu] = useState(false);
  const [xiaohongshuProgress, setXiaohongshuProgress] = useState("");
  const [resolvingReview, setResolvingReview] = useState("");
  const [reviewActionErrors, setReviewActionErrors] = useState<
    Record<string, string>
  >({});
  const [reviewInputs, setReviewInputs] = useState<
    Record<
      string,
      { note: string; externalDraftId: string; externalUrl: string }
    >
  >({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>(
    {},
  );
  const [reviewInsertPlacements, setReviewInsertPlacements] = useState<
    Record<string, ArticleImagePlacement>
  >({});
  const [lightboxUrl, setLightboxUrl] = useState("");
  const [reviewAssets, setReviewAssets] = useState<ReviewAsset[]>([]);
  const [reviewCoverAdjustments, setReviewCoverAdjustments] = useState<
    Record<
      string,
      {
        sourceAssetId: string;
        regions: Partial<Record<WechatCoverCropTarget, CropRegion>>;
      }
    >
  >({});
  const [reviewPreviews, setReviewPreviews] = useState<
    Partial<Record<Channel, { html: string; coverUrl?: string }>>
  >({});
  const [reviewPreviewStates, setReviewPreviewStates] = useState<
    Record<
      string,
      {
        status: "idle" | "loading" | "success" | "error";
        message?: string;
      }
    >
  >({});
  const [previewVersions, setPreviewVersions] = useState<
    Partial<Record<Channel, number>>
  >({});
  const [imageSuggestions, setImageSuggestions] = useState<ImageSuggestion[]>(
    [],
  );
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState("");
  const [suggestionsWarning, setSuggestionsWarning] = useState("");
  const [imageGeneration, setImageGeneration] =
    useState<ImageSuggestionGeneration | null>(null);
  const [startingImageGeneration, setStartingImageGeneration] = useState(false);
  const [smartImageUploading, setSmartImageUploading] = useState(false);
  const [suggestionFilter, setSuggestionFilter] = useState<
    "all" | "generated" | "geekhome" | "upload"
  >("all");
  const [selectedSuggestionKeys, setSelectedSuggestionKeys] = useState<
    Set<string>
  >(new Set());

  useEffect(() => {
    if (!lightboxUrl) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxUrl("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lightboxUrl]);

  const loadImageSuggestions = useCallback(
    async (showLoading = false) => {
      if (showLoading) setSuggestionsLoading(true);
      try {
        const response = await fetch(
          `/api/content-jobs/${params.jobId}/image-suggestions`,
          { credentials: "include", cache: "no-store" },
        );
        const data = (await response.json()) as ImageSuggestionPayload;
        if (!response.ok)
          throw new Error(data.message ?? "相关图片推荐暂时不可用");
        setImageSuggestions((current) => [
          ...current.filter((suggestion) => suggestion.source === "upload"),
          ...(data.suggestions ?? []),
        ]);
        setImageGeneration(data.generation ?? null);
        setSuggestionsWarning(data.warning ?? "");
        setSuggestionsError("");
        const generatedAssets = (data.suggestions ?? []).flatMap<ReviewAsset>(
          (suggestion) =>
            suggestion.source === "generated" && suggestion.assetId
              ? [
                  {
                    id: suggestion.assetId,
                    fileUrl: suggestion.url,
                    status: "ready",
                    metadata: {
                      displayName: suggestion.title,
                      chapterHeading: suggestion.chapterHeading,
                    },
                  },
                ]
              : [],
        );
        setReviewAssets((current) => [
          ...current,
          ...generatedAssets.filter(
            (candidate) => !current.some((asset) => asset.id === candidate.id),
          ),
        ]);
        return data;
      } catch (reason) {
        setSuggestionsError(
          reason instanceof Error ? reason.message : "相关图片抓取失败",
        );
        return null;
      } finally {
        if (showLoading) setSuggestionsLoading(false);
      }
    },
    [params.jobId],
  );

  const updateReviewActionError = (reviewId: string, message: string) =>
    setReviewActionErrors((current) => ({
      ...current,
      [reviewId]: message,
    }));
  const [reviewImageBusy, setReviewImageBusy] = useState<{
    reviewId: string;
    slotIndex: number;
    action: "upload" | "crop";
  } | null>(null);
  const [reviewImageFeedback, setReviewImageFeedback] = useState<
    Record<
      string,
      Record<number, { tone: "success" | "error"; message: string }>
    >
  >({});
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const reviewAssetsLoaded = useRef(false);
  const previewInitialized = useRef(false);
  const suggestionsLoaded = useRef(false);
  const automaticPreviewRequests = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      let shouldRetry = true;
      try {
        const response = await fetch(`/api/content-jobs/${params.jobId}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          if (response.status === 403 || response.status === 404) {
            shouldRetry = false;
            throw new Error("任务不存在或无权访问");
          }
          throw new Error(
            `任务详情暂时加载失败（HTTP ${response.status}），系统将自动重试`,
          );
        }
        const data = (await response.json()) as { job: ContentJob };
        if (cancelled) return;
        setError("");
        setJob(data.job);
        if (data.job.result && !suggestionsLoaded.current) {
          suggestionsLoaded.current = true;
          void loadImageSuggestions(true);
        }
        const editableReviews = (data.job.reviews || []).filter(
          (review) =>
            review.status === "pending" &&
            review.category === "content_quality",
        );
        if (editableReviews.length) {
          setReviewDrafts((current) => {
            const next = { ...current };
            for (const review of editableReviews) {
              if (next[review.id]) continue;
              const artifact =
                data.job.result?.channelArtifacts?.[review.target];
              const article =
                artifact?.article ??
                data.job.result?.channelArticles?.[review.target] ??
                data.job.result?.article;
              if (!article) continue;
              const artifactAssets = artifact?.assets ?? [];
              const slotCount = artifactAssets.length;
              const generatedInlineOnly =
                data.job.input.imageMode === "generated" &&
                data.job.input.contentType === "general";
              next[review.id] = {
                article: structuredClone(article),
                cover: artifact?.reviewedCoverUrl
                  ? {
                      source: "existing" as const,
                      url: artifact.reviewedCoverUrl,
                    }
                  : undefined,
                images: Array.from({ length: slotCount }, (_, index) => {
                  const url = artifactAssets[index]?.selected?.url;
                  if (!url) return null;
                  return {
                    source: "existing" as const,
                    url,
                    placement:
                      !generatedInlineOnly && index === 0
                        ? ({ anchor: "cover" } as const)
                        : (artifactAssets[index]?.placement ?? {
                            anchor: "after_section",
                            sectionIndex: Math.min(
                              generatedInlineOnly ? index : index - 1,
                              Math.max(0, article.sections.length - 1),
                            ),
                          }),
                  };
                }),
              };
            }
            return next;
          });
          if (!reviewAssetsLoaded.current) {
            reviewAssetsLoaded.current = true;
            const assetsResponse = await fetch("/api/assets", {
              credentials: "include",
              cache: "no-store",
            });
            if (assetsResponse.ok && !cancelled) {
              const assetsData = (await assetsResponse.json()) as {
                assets: ReviewAsset[];
              };
              setReviewAssets(
                assetsData.assets.filter(
                  (asset) => asset.status === "ready" && asset.fileUrl,
                ),
              );
            }
          }
        }
        if (!previewInitialized.current) {
          previewInitialized.current = true;
          const initialReview = [...editableReviews].sort(
            (left, right) =>
              [
                "official_site",
                "wechat",
                "xiaohongshu",
                "zhihu",
                "toutiao",
                "baijiahao",
                "linkedin",
              ].indexOf(left.target) -
              [
                "official_site",
                "wechat",
                "xiaohongshu",
                "zhihu",
                "toutiao",
                "baijiahao",
                "linkedin",
              ].indexOf(right.target),
          )[0];
          if (initialReview) setPreview(initialReview.target);
          else if (!data.job.input.targets.includes("official_site"))
            setPreview(data.job.input.targets[0] ?? "official_site");
        }
        if (!terminal.has(data.job.status) && !cancelled)
          if (shouldRetry) timer = window.setTimeout(load, 2000);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "任务读取失败");
          timer = window.setTimeout(load, 2000);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [detailReloadKey, loadImageSuggestions, params.jobId]);

  useEffect(() => {
    if (!job) return;
    for (const review of job.reviews ?? []) {
      if (
        review.status !== "pending" ||
        review.category !== "content_quality" ||
        reviewPreviews[review.target] ||
        automaticPreviewRequests.current.has(review.id)
      )
        continue;
      const draft = reviewDrafts[review.id];
      if (!draft) continue;
      const existingHtml = storedChannelHtml(job, review.target);
      if (existingHtml) continue;
      automaticPreviewRequests.current.add(review.id);
      void (async () => {
        try {
          const response = await fetch(
            `/api/manual-reviews/${review.id}/preview`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "content-type": "application/json",
                "x-csrf-token": await csrfToken(),
              },
              body: JSON.stringify({
                article: draft.article,
                images: serializeReviewImages(draft.images),
                cover: serializeReviewCover(draft.cover),
              }),
            },
          );
          const data = (await response.json()) as {
            html?: string;
            coverUrl?: string;
            message?: string;
          };
          if (!response.ok || !data.html)
            throw new Error(data.message || "初始文章预览生成失败");
          setReviewPreviews((current) => ({
            ...current,
            [review.target]: {
              html: data.html!,
              coverUrl: data.coverUrl,
            },
          }));
        } catch (reason) {
          updateReviewActionError(
            review.id,
            reason instanceof Error
              ? reason.message
              : "初始文章预览生成失败，请点击预览重试",
          );
        }
      })();
    }
  }, [job, reviewDrafts, reviewPreviews]);

  useEffect(() => {
    if (
      !imageGeneration ||
      !["queued", "running"].includes(imageGeneration.status)
    )
      return;
    const timer = window.setInterval(() => {
      void fetch(
        `/api/content-jobs/${params.jobId}/image-suggestions/generation`,
        { credentials: "include", cache: "no-store" },
      )
        .then(async (response) => {
          const data = (await response.json()) as {
            generation?: ImageSuggestionGeneration | null;
          };
          if (!response.ok || !data.generation) return;
          setImageGeneration(data.generation);
          if (data.generation.status === "completed")
            await loadImageSuggestions(false);
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [imageGeneration, loadImageSuggestions, params.jobId]);

  async function startImageCandidateGeneration() {
    setStartingImageGeneration(true);
    setSuggestionsError("");
    try {
      const response = await fetch(
        `/api/content-jobs/${params.jobId}/image-suggestions/generate`,
        {
          method: "POST",
          credentials: "include",
          headers: { "x-csrf-token": await csrfToken() },
        },
      );
      const data = (await response.json()) as {
        generation?: ImageSuggestionGeneration;
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.message ?? data.error ?? "插图生成任务提交失败");
      setImageGeneration(
        data.generation ?? {
          status: "queued",
          completed: 0,
          total: 0,
          message: "已提交生成任务",
        },
      );
      setSuggestionFilter("generated");
    } catch (reason) {
      setSuggestionsError(
        reason instanceof Error ? reason.message : "插图生成任务提交失败",
      );
    } finally {
      setStartingImageGeneration(false);
    }
  }

  async function uploadSmartImage(file: File) {
    if (!file.size) {
      setSuggestionsError(
        "图片内容为空。请先等待 iCloud 图片下载完成，再重新选择。",
      );
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setSuggestionsError(`“${file.name}”超过单张 20 MiB 限制`);
      return;
    }
    if (
      file.type &&
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      setSuggestionsError("仅支持 PNG、JPG 和 WebP 图片");
      return;
    }
    setSmartImageUploading(true);
    setSuggestionsError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/assets/upload", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
        body: form,
      });
      const data = (await response.json().catch(() => ({}))) as {
        asset?: ReviewAsset;
        error?: string;
        message?: string;
      };
      if (!response.ok || !data.asset?.fileUrl)
        throw new Error(
          data.message ||
            (response.status === 413
              ? "图片超过单张 20 MiB 限制"
              : `图片上传失败（HTTP ${response.status}）`),
        );
      const asset = data.asset;
      setReviewAssets((current) => [
        asset,
        ...current.filter((item) => item.id !== asset.id),
      ]);
      setImageSuggestions((current) => [
        {
          source: "upload",
          assetId: asset.id,
          materialId: `upload-${asset.id}`,
          title: String(
            asset.metadata.displayName ??
              asset.metadata.originalName ??
              file.name,
          ),
          url: asset.fileUrl!,
          description: "运营人员上传图片",
          role: "inline",
          usageCount: 0,
          copyright: "内部上传素材，请确认使用权限",
        },
        ...current.filter((item) => item.assetId !== asset.id),
      ]);
      setSuggestionFilter("upload");
    } catch (reason) {
      setSuggestionsError(
        reason instanceof TypeError
          ? "图片上传请求未完成，请检查文件是否已从 iCloud 下载"
          : reason instanceof Error
            ? reason.message
            : "图片上传失败",
      );
    } finally {
      setSmartImageUploading(false);
    }
  }

  function waitForExtensionMessage(
    requestId: string,
    type:
      | "GD_XHS_PONG"
      | "GD_XHS_CONNECTION_RESULT"
      | "GD_XHS_PAIR_RESULT"
      | "GD_XHS_UPLOAD_RESULT",
    timeoutMs: number,
  ) {
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(
          new Error(
            type === "GD_XHS_PONG"
              ? "未检测到多平台草稿助手，请先安装并刷新本页"
              : type === "GD_XHS_CONNECTION_RESULT"
                ? "扩展已安装，但连接检查超时，请检查网络后重试"
                : type === "GD_XHS_PAIR_RESULT"
                  ? "当前电脑自动连接超时，请刷新页面后重试"
                  : "扩展执行超时，请到对应平台草稿箱和任务详情人工核对",
          ),
        );
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        if (
          event.source !== window ||
          event.origin !== window.location.origin ||
          event.data?.type !== type ||
          event.data?.requestId !== requestId
        )
          return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data);
      };
      window.addEventListener("message", onMessage);
    });
  }

  async function pingXiaohongshuExtension() {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const pingId = crypto.randomUUID();
        const pong = waitForExtensionMessage(pingId, "GD_XHS_PONG", 1800);
        window.postMessage(
          { type: "GD_XHS_PING", requestId: pingId },
          window.location.origin,
        );
        return await pong;
      } catch (error) {
        lastError = error;
        if (attempt < 2)
          await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
    }
    throw lastError;
  }

  async function startBrowserDraftUpload(taskId: string, channel: Channel) {
    const channelName = channelNames[channel];
    setStartingXiaohongshu(true);
    setXiaohongshuProgress(`正在检查当前电脑的多平台草稿助手…`);
    setActionError("");
    let removeProgressListener: (() => void) | undefined;
    let newConnectionId = "";
    try {
      const pongResult = await pingXiaohongshuExtension();
      if (
        !isExtensionVersionAtLeast(
          pongResult.version || "",
          REQUIRED_XHS_EXTENSION_VERSION,
        )
      )
        throw new Error(
          "多平台草稿助手需要更新，请到“渠道管理”重新下载安装最新版。",
        );

      let needsPairing = pongResult.configured !== true;
      if (!needsPairing) {
        const connectionId = crypto.randomUUID();
        const checked = waitForExtensionMessage(
          connectionId,
          "GD_XHS_CONNECTION_RESULT",
          6000,
        );
        window.postMessage(
          { type: "GD_XHS_CHECK_CONNECTION", requestId: connectionId },
          window.location.origin,
        );
        const connectionMessage = await checked;
        const connectionResult = connectionMessage.result as {
          ok?: boolean;
          reconnectRequired?: boolean;
          error?: string;
        };
        if (connectionResult?.reconnectRequired === true) needsPairing = true;
        else if (connectionResult?.ok !== true)
          throw new Error(
            connectionResult?.error ||
              "扩展已安装，但暂时无法连接运营中心，请检查网络后重试。",
          );
      }

      if (needsPairing) {
        setXiaohongshuProgress("首次使用，正在自动连接这台电脑…");
        const connectionResponse = await fetch("/api/extension-tokens", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": await csrfToken(),
          },
          body: JSON.stringify({
            name: `多平台草稿助手 · ${navigator.platform || "Chrome"}`,
          }),
        });
        const connection = (await connectionResponse.json()) as {
          token?: { id: string; token: string };
          message?: string;
        };
        if (!connectionResponse.ok || !connection.token)
          throw new Error(connection.message || "当前电脑自动连接失败");
        newConnectionId = connection.token.id;
        const pairId = crypto.randomUUID();
        const paired = waitForExtensionMessage(
          pairId,
          "GD_XHS_PAIR_RESULT",
          8_000,
        );
        window.postMessage(
          {
            type: "GD_XHS_PAIR",
            requestId: pairId,
            token: connection.token.token,
            deviceName: navigator.platform || "Chrome",
          },
          window.location.origin,
        );
        const pairResult = await paired;
        if (!pairResult.result?.ok)
          throw new Error(pairResult.result?.error || "当前电脑自动连接失败");
        newConnectionId = "";
      }

      const requestId = crypto.randomUUID();
      const onProgress = (event: MessageEvent) => {
        if (
          event.source === window &&
          event.origin === window.location.origin &&
          event.data?.type === "GD_XHS_UPLOAD_PROGRESS" &&
          event.data?.requestId === requestId
        )
          setXiaohongshuProgress(
            event.data.result?.message || `正在保存${channelName}草稿…`,
          );
      };
      window.addEventListener("message", onProgress);
      removeProgressListener = () =>
        window.removeEventListener("message", onProgress);
      const completed = waitForExtensionMessage(
        requestId,
        "GD_XHS_UPLOAD_RESULT",
        12 * 60_000,
      );
      window.postMessage(
        { type: "GD_XHS_START_UPLOAD", requestId, taskId, channel },
        window.location.origin,
      );
      const message = await completed;
      removeProgressListener();
      removeProgressListener = undefined;
      const result = message.result as {
        ok?: boolean;
        empty?: boolean;
        error?: string;
        result?: { status?: string; message?: string };
      };
      if (!result?.ok)
        throw new Error(
          result?.error ?? result?.result?.message ?? "扩展上传失败",
        );
      window.location.reload();
    } catch (reason) {
      if (newConnectionId) {
        try {
          await fetch(`/api/extension-tokens/${newConnectionId}`, {
            method: "DELETE",
            credentials: "include",
            headers: { "x-csrf-token": await csrfToken() },
          });
        } catch {
          // Connection records expire automatically; preserve the actionable
          // upload error when best-effort cleanup cannot reach the server.
        }
      }
      setActionError(reason instanceof Error ? reason.message : "扩展上传失败");
      setStartingXiaohongshu(false);
      setXiaohongshuProgress("");
    } finally {
      removeProgressListener?.();
    }
  }

  async function retryFailedTargets() {
    setRetrying(true);
    setActionError("");
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/content-jobs/${params.jobId}/retry`, {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": token },
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(data.message ?? "重试提交失败");
      window.location.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "重试提交失败");
      setRetrying(false);
    }
  }

  async function uploadReviewAsset(
    reviewId: string,
    file: File,
    placement: ArticleImagePlacement,
    replaceIndex?: number,
  ) {
    const draftBeforeUpload = reviewDrafts[reviewId];
    if (!draftBeforeUpload) return;
    if (replaceIndex === undefined && draftBeforeUpload.images.length >= 8) {
      updateReviewActionError(reviewId, "单个渠道最多保留 8 张图片");
      return;
    }
    const slotIndex = replaceIndex ?? draftBeforeUpload.images.length;
    const setSlotFeedback = (
      feedback: { tone: "success" | "error"; message: string } | null,
    ) =>
      setReviewImageFeedback((current) => {
        const reviewFeedback = { ...(current[reviewId] ?? {}) };
        if (feedback) reviewFeedback[slotIndex] = feedback;
        else delete reviewFeedback[slotIndex];
        return { ...current, [reviewId]: reviewFeedback };
      });
    if (!file.size) {
      const message =
        "图片内容为空。请先在访达中等待 iCloud 图片下载完成，再重新选择。";
      setSlotFeedback({ tone: "error", message });
      updateReviewActionError(reviewId, message);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      const message = `“${file.name}”为 ${(file.size / 1024 / 1024).toFixed(1)} MiB，超过单张 20 MiB 限制，请压缩后重试。`;
      setSlotFeedback({ tone: "error", message });
      updateReviewActionError(reviewId, message);
      return;
    }
    if (
      file.type &&
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      const message = `不支持“${file.name}”的图片格式，请转换为 PNG、JPG 或 WebP 后重试。`;
      setSlotFeedback({ tone: "error", message });
      updateReviewActionError(reviewId, message);
      return;
    }
    setReviewImageBusy({ reviewId, slotIndex, action: "upload" });
    setSlotFeedback(null);
    updateReviewActionError(reviewId, "");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/assets/upload", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
        body: form,
      });
      const data = (await response.json().catch(() => ({}))) as {
        asset?: ReviewAsset;
        error?: string;
        message?: string;
      };
      if (!response.ok || !data.asset) {
        const message =
          data.message ||
          (response.status === 413 || data.error === "IMAGE_TOO_LARGE"
            ? "图片超过单张 20 MiB 限制，请压缩后重试。"
            : response.status === 524
              ? "服务器处理图片超时（HTTP 524），并非设备断网。图片可能仍在保存，请稍后刷新素材库；如未出现再压缩后重试。"
              : [502, 503, 504].includes(response.status)
                ? `图片服务暂时不可用（HTTP ${response.status}），请稍后重试。`
                : data.error === "INVALID_IMAGE_FILE"
                  ? "图片内容或扩展名无法识别，请使用完整下载的 PNG、JPG 或 WebP。"
                  : `图片上传失败（HTTP ${response.status}），请检查网络后重试。`);
        throw new Error(message);
      }
      setReviewAssets((current) => [
        data.asset!,
        ...current.filter((asset) => asset.id !== data.asset!.id),
      ]);
      setReviewDrafts((current) => {
        const draft = current[reviewId];
        if (!draft) return current;
        const images = [...draft.images];
        const nextImage = {
          source: "asset",
          assetId: data.asset!.id,
          placement,
        } as const;
        if (replaceIndex === undefined) images.push(nextImage);
        else if (replaceIndex >= 0 && replaceIndex < images.length)
          images[replaceIndex] = nextImage;
        else return current;
        return { ...current, [reviewId]: { ...draft, images } };
      });
      setSlotFeedback({
        tone: "success",
        message: `“${file.name}”上传成功，已插入当前正文位置。`,
      });
    } catch (reason) {
      const message =
        reason instanceof TypeError
          ? "图片上传请求未完成，请确认网络正常、iCloud 文件已下载后重试。"
          : reason instanceof Error
            ? reason.message
            : "图片上传失败，请重试";
      setSlotFeedback({ tone: "error", message });
      updateReviewActionError(reviewId, message);
    } finally {
      setReviewImageBusy(null);
    }
  }

  async function createWechatBrandedCover(
    sourceAssetId: string,
    regions?: Partial<Record<WechatCoverCropTarget, CropRegion>>,
  ) {
    const jobResponse = await fetch("/api/image-jobs", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": await csrfToken(),
      },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        operation: "wechat_cover_brand",
        sourceAssetIds: [sourceAssetId],
        ratio: "wechat_cover",
        count: 1,
        quality: "high",
        wechatCoverRegions:
          regions?.wide || regions?.square
            ? {
                wide: regions.wide,
                square: regions.square,
              }
            : undefined,
      }),
    });
    const initial = (await jobResponse.json().catch(() => ({}))) as {
      job?: { id: string };
      message?: string;
    };
    if (!jobResponse.ok || !initial.job)
      throw new Error(initial.message || "公众号封面生成任务创建失败");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const statusResponse = await fetch(`/api/image-jobs/${initial.job.id}`, {
        credentials: "include",
        cache: "no-store",
      });
      const status = (await statusResponse.json()) as {
        job?: { status: string; outputs: ReviewAsset[]; errorCode?: string };
      };
      if (status.job?.status === "completed") {
        const output = status.job.outputs[0];
        if (output) return output;
        throw new Error("公众号封面任务完成但没有返回图片");
      }
      if (
        ["failed", "cancelled", "manual_review"].includes(
          status.job?.status || "",
        )
      )
        throw new Error(status.job?.errorCode || "公众号封面裁剪与品牌化失败");
    }
    throw new Error("公众号封面仍在后台生成，请稍后从内容资产中选择结果");
  }

  async function uploadReviewCover(reviewId: string, file: File) {
    const draft = reviewDrafts[reviewId];
    if (!draft) return;
    if (!file.size || file.size > 20 * 1024 * 1024) {
      updateReviewActionError(
        reviewId,
        !file.size
          ? "图片内容为空，请等待 iCloud 原图下载完成后重试"
          : "公众号封面原图不能超过 20 MiB",
      );
      return;
    }
    if (
      file.type &&
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      updateReviewActionError(reviewId, "封面仅支持 PNG、JPG 或 WebP 图片");
      return;
    }
    setReviewImageBusy({ reviewId, slotIndex: -1, action: "upload" });
    updateReviewActionError(reviewId, "");
    try {
      const uploadFile = await optimizeWechatCoverUpload(file);
      const form = new FormData();
      form.append("file", uploadFile);
      const response = await fetch("/api/assets/upload", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
        body: form,
      });
      const data = (await response.json().catch(() => ({}))) as {
        asset?: ReviewAsset;
        message?: string;
      };
      if (!response.ok || !data.asset)
        throw new Error(
          data.message ||
            (response.status === 524
              ? "服务器接收封面图片超时（HTTP 524）。系统已在上传前自动压缩；请稍后重试，若素材库已出现该图片则无需重复上传。"
              : `封面上传失败（HTTP ${response.status}）`),
        );
      setReviewAssets((current) => [
        data.asset!,
        ...current.filter((asset) => asset.id !== data.asset!.id),
      ]);
      const brandedCover = await createWechatBrandedCover(data.asset.id);
      setReviewAssets((current) => [
        brandedCover!,
        ...current.filter((asset) => asset.id !== brandedCover!.id),
      ]);
      const nextDraft: ReviewDraft = {
        ...draft,
        cover: { source: "asset", assetId: brandedCover.id },
      };
      setReviewDrafts((current) => ({
        ...current,
        [reviewId]: nextDraft,
      }));
      setReviewCoverAdjustments((current) => ({
        ...current,
        [reviewId]: { sourceAssetId: data.asset!.id, regions: {} },
      }));
      await requestManualReviewPreview(reviewId, nextDraft);
    } catch (reason) {
      updateReviewActionError(
        reviewId,
        reason instanceof Error ? reason.message : "封面上传失败，请重试",
      );
    } finally {
      setReviewImageBusy(null);
    }
  }

  async function cropReviewCover(
    reviewId: string,
    target: WechatCoverCropTarget,
    cropRegion: CropRegion,
  ) {
    const draft = reviewDrafts[reviewId];
    if (!draft?.cover) return;
    const coverAssetId =
      draft.cover.source === "asset" ? draft.cover.assetId : undefined;
    const coverAsset = coverAssetId
      ? reviewAssets.find((asset) => asset.id === coverAssetId)
      : undefined;
    const remembered = reviewCoverAdjustments[reviewId];
    const sourceAssetId =
      remembered?.sourceAssetId ||
      String(coverAsset?.metadata.derivedFromAssetId ?? "");
    if (!sourceAssetId) {
      updateReviewActionError(
        reviewId,
        "这张历史封面缺少原图记录，请重新上传原图后再调整裁剪选区",
      );
      return;
    }
    const regions = {
      ...(remembered?.regions ?? {}),
      [target]: cropRegion,
    };
    setReviewImageBusy({ reviewId, slotIndex: -1, action: "crop" });
    updateReviewActionError(reviewId, "");
    try {
      const brandedCover = await createWechatBrandedCover(
        sourceAssetId,
        regions,
      );
      setReviewAssets((current) => [
        brandedCover,
        ...current.filter((asset) => asset.id !== brandedCover.id),
      ]);
      const nextDraft: ReviewDraft = {
        ...draft,
        cover: { source: "asset", assetId: brandedCover.id },
      };
      setReviewDrafts((current) => ({
        ...current,
        [reviewId]: nextDraft,
      }));
      setReviewCoverAdjustments((current) => ({
        ...current,
        [reviewId]: { sourceAssetId, regions },
      }));
      setReviewImageFeedback((current) => ({
        ...current,
        [reviewId]: {
          ...(current[reviewId] ?? {}),
          [-1]: {
            tone: "success",
            message:
              target === "wide"
                ? "公众号 2.35:1 首图选区已更新"
                : "公众号 1:1 次图选区已更新",
          },
        },
      }));
      await requestManualReviewPreview(reviewId, nextDraft);
    } catch (reason) {
      updateReviewActionError(
        reviewId,
        reason instanceof Error ? reason.message : "公众号封面裁剪失败",
      );
    } finally {
      setReviewImageBusy(null);
    }
  }

  async function cropReviewAsset(
    reviewId: string,
    slotIndex: number,
    ratio: CropRatio,
    cropRegion: CropRegion,
  ) {
    const draft = reviewDrafts[reviewId];
    const image = draft?.images[slotIndex];
    if (!draft || !image) {
      updateReviewActionError(
        reviewId,
        "请先为该位置选择或上传图片，再执行裁剪",
      );
      return;
    }
    setReviewImageBusy({ reviewId, slotIndex, action: "crop" });
    updateReviewActionError(reviewId, "");
    try {
      let sourceAssetId: string;
      if (image.source === "asset") sourceAssetId = image.assetId;
      else {
        const importResponse = await fetch("/api/assets/import", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": await csrfToken(),
          },
          body: JSON.stringify({ url: image.url }),
        });
        const imported = (await importResponse.json()) as {
          asset?: ReviewAsset;
          message?: string;
        };
        if (!importResponse.ok || !imported.asset)
          throw new Error(imported.message || "原图片导入失败，请重新上传图片");
        sourceAssetId = imported.asset.id;
        setReviewAssets((current) => [
          imported.asset!,
          ...current.filter((asset) => asset.id !== imported.asset!.id),
        ]);
      }
      const response = await fetch("/api/image-jobs", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          operation: "crop",
          sourceAssetIds: [sourceAssetId],
          cropRegion,
          ratio,
          count: 1,
          quality: "high",
        }),
      });
      const initial = (await response.json()) as {
        job?: { id: string };
        message?: string;
      };
      if (!response.ok || !initial.job)
        throw new Error(initial.message || "裁剪任务创建失败");
      const deadline = Date.now() + 90_000;
      let output: ReviewAsset | undefined;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const statusResponse = await fetch(
          `/api/image-jobs/${initial.job.id}`,
          { credentials: "include", cache: "no-store" },
        );
        const status = (await statusResponse.json()) as {
          job?: { status: string; outputs: ReviewAsset[]; errorCode?: string };
        };
        if (status.job?.status === "completed") {
          output = status.job.outputs[0];
          break;
        }
        if (
          ["failed", "cancelled", "manual_review"].includes(
            status.job?.status || "",
          )
        )
          throw new Error(status.job?.errorCode || "图片裁剪失败");
      }
      if (!output)
        throw new Error("图片仍在后台裁剪，请稍后从内容资产中选择结果");
      setReviewAssets((current) => [
        output!,
        ...current.filter((asset) => asset.id !== output!.id),
      ]);
      setReviewDrafts((current) => {
        const currentDraft = current[reviewId];
        if (!currentDraft) return current;
        const images = [...currentDraft.images];
        images[slotIndex] = {
          source: "asset",
          assetId: output!.id,
          placement: images[slotIndex]?.placement,
        };
        return { ...current, [reviewId]: { ...currentDraft, images } };
      });
      setReviewImageFeedback((current) => ({
        ...current,
        [reviewId]: {
          ...(current[reviewId] ?? {}),
          [slotIndex]: {
            tone: "success",
            message: `图片位置 ${slotIndex + 1} 已完成裁剪。`,
          },
        },
      }));
    } catch (reason) {
      updateReviewActionError(
        reviewId,
        reason instanceof Error ? reason.message : "图片裁剪失败",
      );
    } finally {
      setReviewImageBusy(null);
    }
  }

  async function requestManualReviewPreview(
    reviewId: string,
    draft: ReviewDraft,
  ) {
    const review = job?.reviews?.find((item) => item.id === reviewId);
    if (!review) return;
    updateReviewActionError(reviewId, "");
    setReviewPreviewStates((current) => ({
      ...current,
      [reviewId]: {
        status: "loading",
        message: "正在根据当前编辑内容重新排版",
      },
    }));
    try {
      const response = await fetch(`/api/manual-reviews/${reviewId}/preview`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          article: draft.article,
          images: serializeReviewImages(draft.images),
          cover: serializeReviewCover(draft.cover),
        }),
      });
      const data = (await response.json()) as {
        html?: string;
        coverUrl?: string;
        message?: string;
      };
      if (!response.ok || !data.html)
        throw new Error(data.message || "修改预览生成失败");
      setReviewPreviews((current) => ({
        ...current,
        [review.target]: { html: data.html!, coverUrl: data.coverUrl },
      }));
      setPreviewVersions((current) => ({
        ...current,
        [review.target]: (current[review.target] ?? 0) + 1,
      }));
      setPreview(review.target);
      setReviewPreviewStates((current) => ({
        ...current,
        [reviewId]: {
          status: "success",
          message: "预览已更新，已定位到上方渠道预览区",
        },
      }));
      window.requestAnimationFrame(() =>
        document
          .getElementById("channel-preview-panel")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "修改预览生成失败";
      setReviewPreviewStates((current) => ({
        ...current,
        [reviewId]: { status: "error", message },
      }));
      updateReviewActionError(reviewId, message);
    }
  }

  async function previewManualReview(reviewId: string) {
    const draft = reviewDrafts[reviewId];
    if (!draft) return;
    await requestManualReviewPreview(reviewId, draft);
  }

  async function resolveManualReview(
    reviewId: string,
    decision:
      | "approve_content"
      | "reject_content"
      | "confirm_drafted"
      | "confirm_absent_retry",
  ) {
    const input = reviewInputs[reviewId] || {
      note: "",
      externalDraftId: "",
      externalUrl: "",
    };
    const reviewDraft = reviewDrafts[reviewId];
    if (decision === "approve_content") {
      if (!reviewDraft) {
        updateReviewActionError(reviewId, "文章数据尚未加载完成，请刷新后重试");
        return;
      }
      const article = reviewDraft.article;
      if (
        !article.title.trim() ||
        !article.description.trim() ||
        article.opening.filter((paragraph) => paragraph.trim()).length < 2 ||
        article.sections.length < 3 ||
        article.sections.some(
          (section) =>
            !section.heading.trim() ||
            !section.paragraphs.some((paragraph) => paragraph.trim()),
        ) ||
        !article.observation.trim() ||
        !article.conclusion.trim()
      ) {
        updateReviewActionError(
          reviewId,
          "文章内容不完整：请检查标题、摘要、至少两段开篇、各章节正文、观察和总结",
        );
        return;
      }
      const selectedImages = reviewDraft.images.filter(Boolean);
      const imageKeys = selectedImages.map((image) =>
        image?.source === "asset"
          ? image.assetId
          : image?.source === "suggestion"
            ? image.materialId
            : image?.url,
      );
      if (new Set(imageKeys).size !== imageKeys.length) {
        updateReviewActionError(reviewId, "同一张图片不能重复使用");
        return;
      }
      const review = job?.reviews?.find((item) => item.id === reviewId);
      if (
        review?.target === "wechat" &&
        Array.from(reviewDraft.article.title).length > 32
      ) {
        updateReviewActionError(reviewId, "公众号标题不能超过 32 个字符");
        return;
      }
      if (
        review?.target === "wechat" &&
        Array.from(reviewDraft.article.description).length > 128
      ) {
        updateReviewActionError(reviewId, "公众号摘要不能超过 128 个字符");
        return;
      }
    }
    const currentReview = job?.reviews?.find((item) => item.id === reviewId);
    const confirmations = {
      approve_content:
        "确认内容符合要求，并仅为当前渠道创建草稿？其他已成功渠道不会重复写入。",
      reject_content: "确认驳回当前渠道内容？该渠道将停止，不会写入外部平台。",
      confirm_drafted:
        "确认已在渠道后台核对到草稿？此操作只更新内部状态，不会再次调用渠道。",
      confirm_absent_retry:
        currentReview?.target === "xiaohongshu"
          ? "确认将当前复核内容保存到当前电脑已登录的小红书草稿箱？系统不会正式发布。"
          : "确认已在渠道后台核对且草稿不存在？系统将仅重试当前渠道，错误确认可能产生重复草稿。",
    };
    const requiresConfirmation = currentReview?.target !== "xiaohongshu";
    if (requiresConfirmation && !window.confirm(confirmations[decision]))
      return;
    setResolvingReview(reviewId);
    updateReviewActionError(reviewId, "");
    try {
      const response = await fetch(`/api/manual-reviews/${reviewId}/decision`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          decision,
          note: input.note.trim() || undefined,
          externalDraftId: input.externalDraftId.trim() || undefined,
          externalUrl: input.externalUrl.trim() || undefined,
          artifactRevision:
            decision === "approve_content" && reviewDraft
              ? {
                  article: reviewDraft.article,
                  images: serializeReviewImages(reviewDraft.images),
                  cover: serializeReviewCover(reviewDraft.cover),
                }
              : undefined,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? data.message || "该复核已由其他成员处理，请刷新页面"
            : data.message || data.error || "复核提交失败",
        );
      const review = job?.reviews?.find((item) => item.id === reviewId);
      const browserChannel = browserDraftChannels.find(
        (channel) => channel === review?.target,
      );
      if (
        browserChannel &&
        ["approve_content", "confirm_absent_retry"].includes(decision)
      ) {
        const browserChannelName = channelNames[browserChannel];
        setXiaohongshuProgress(
          `复核已通过，正在准备${browserChannelName}草稿包…`,
        );
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_500));
          const detailResponse = await fetch(
            `/api/content-jobs/${params.jobId}`,
            {
              credentials: "include",
              cache: "no-store",
            },
          );
          if (!detailResponse.ok) continue;
          const detail = (await detailResponse.json()) as { job?: ContentJob };
          const uploadTask = detail.job?.targets.find(
            (target) => target.target === browserChannel,
          )?.uploadTask;
          if (uploadTask?.id && uploadTask.status === "waiting_for_uploader") {
            await startBrowserDraftUpload(uploadTask.id, browserChannel);
            return;
          }
          if (
            detail.job?.targets.some(
              (target) =>
                target.target === browserChannel &&
                ["failed", "manual_review"].includes(target.status),
            )
          )
            break;
        }
        throw new Error(
          `${browserChannelName}草稿包准备超时，请刷新页面后再点击保存草稿`,
        );
      }
      window.location.reload();
    } catch (reason) {
      updateReviewActionError(
        reviewId,
        reason instanceof Error ? reason.message : "复核提交失败",
      );
      setResolvingReview("");
    }
  }

  async function moveToTrash() {
    if (!job || !terminal.has(job.status)) return;
    if (
      !window.confirm(
        "将该任务移入回收站？官网或公众号中已经生成的草稿不会被删除。",
      )
    )
      return;
    setDeleting(true);
    setActionError("");
    try {
      const response = await fetch(`/api/content-jobs/${job.id}/trash`, {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
      });
      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.message ?? data.error ?? "任务删除失败");
      router.push("/tasks/trash");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "任务删除失败");
      setDeleting(false);
    }
  }

  async function cancelJob() {
    if (!job || terminal.has(job.status)) return;
    const hasCreatedDraft = job.targets.some(
      (target) => target.status === "drafted",
    );
    if (
      !window.confirm(
        hasCreatedDraft
          ? "取消尚未执行的渠道任务？官网、公众号等已经创建的草稿会保留。"
          : "取消该任务？尚未开始的渠道写入将不会执行。",
      )
    )
      return;
    setCancelling(true);
    setActionError("");
    try {
      const response = await fetch(`/api/content-jobs/${job.id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
      });
      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.message ?? data.error ?? "任务取消失败");
      window.location.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "任务取消失败");
      setCancelling(false);
    }
  }

  function addSuggestedImage(suggestion: ImageSuggestion) {
    const review = (job?.reviews || []).find(
      (item) =>
        item.status === "pending" &&
        item.category === "content_quality" &&
        item.target === preview,
    );
    if (!review || !reviewDrafts[review.id]) {
      setSuggestionsError(
        "当前渠道已经写入草稿或不在内容复核中。推荐图可预览，但只有复核中的渠道能插入后重新创建草稿。",
      );
      return;
    }
    const draft = reviewDrafts[review.id]!;
    const insertionPlacement =
      reviewInsertPlacements[review.id] ??
      ({ anchor: "after_summary" } as const);
    if (draft.images.length >= 8) {
      setSuggestionsError("单个渠道最多保留 8 张图片，请先删除一张再插入");
      return;
    }
    if (
      draft.images.some((image) =>
        image?.source === "existing"
          ? image.url === suggestion.url
          : suggestion.assetId
            ? image?.source === "asset" && image.assetId === suggestion.assetId
            : image?.source === "suggestion" && image.url === suggestion.url,
      )
    ) {
      setSuggestionsError("这张图片已经在当前复核稿中");
      return;
    }
    setReviewDrafts((current) => ({
      ...current,
      [review.id]: {
        ...draft,
        images: [
          ...draft.images,
          suggestion.assetId
            ? {
                source: "asset",
                assetId: suggestion.assetId,
                placement: insertionPlacement,
              }
            : {
                source: "suggestion",
                materialId: suggestion.materialId,
                title: suggestion.title,
                url: suggestion.url,
                placement: insertionPlacement,
              },
        ],
      },
    }));
    setSuggestionsError("");
  }

  function suggestionKey(suggestion: ImageSuggestion) {
    return `${suggestion.materialId}\n${suggestion.url}`;
  }

  function selectedSuggestions() {
    return imageSuggestions.filter((suggestion) =>
      selectedSuggestionKeys.has(suggestionKey(suggestion)),
    );
  }

  function toggleSuggestedImage(suggestion: ImageSuggestion) {
    const key = suggestionKey(suggestion);
    setSelectedSuggestionKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function insertSelectedSuggestions() {
    const review = (job?.reviews || []).find(
      (item) =>
        item.status === "pending" &&
        item.category === "content_quality" &&
        item.target === preview,
    );
    const selected = selectedSuggestions();
    if (!review || !reviewDrafts[review.id] || !selected.length) return;
    const draft = reviewDrafts[review.id]!;
    const placement =
      reviewInsertPlacements[review.id] ??
      ({ anchor: "after_summary" } as const);
    const existingUrls = new Set(
      draft.images.flatMap((image) =>
        image?.source === "existing" || image?.source === "suggestion"
          ? [image.url]
          : [],
      ),
    );
    const existingAssetIds = new Set(
      draft.images.flatMap((image) =>
        image?.source === "asset" ? [image.assetId] : [],
      ),
    );
    const additions = selected
      .filter((suggestion) =>
        suggestion.assetId
          ? !existingAssetIds.has(suggestion.assetId)
          : !existingUrls.has(suggestion.url),
      )
      .slice(0, Math.max(0, 8 - draft.images.length))
      .map((suggestion) =>
        suggestion.assetId
          ? ({
              source: "asset",
              assetId: suggestion.assetId,
              placement,
            } as const)
          : ({
              source: "suggestion",
              materialId: suggestion.materialId,
              title: suggestion.title,
              url: suggestion.url,
              placement,
            } as const),
      );
    setReviewDrafts((current) => ({
      ...current,
      [review.id]: {
        ...current[review.id]!,
        images: [...current[review.id]!.images, ...additions],
      },
    }));
    if (additions.length < selected.length)
      setSuggestionsError("部分重复图片或超过 8 张上限，已插入其余可用图片");
    else setSuggestionsError("");
    setSelectedSuggestionKeys(new Set());
  }

  function useSelectedSuggestionAsCover() {
    const suggestion = selectedSuggestions()[0];
    if (!suggestion || selectedSuggestionKeys.size !== 1) return;
    const review = (job?.reviews || []).find(
      (item) =>
        item.status === "pending" &&
        item.category === "content_quality" &&
        item.target === preview,
    );
    if (!review || !reviewDrafts[review.id]) {
      setSuggestionsError("请先切换到正在复核的官网或公众号渠道");
      return;
    }
    if (review.target !== "official_site" && review.target !== "wechat") {
      setSuggestionsError("小红书使用正文首图作为封面，无需单独设置渠道封面");
      return;
    }
    const cover = suggestion.assetId
      ? ({ source: "asset", assetId: suggestion.assetId } as const)
      : ({
          source: "suggestion",
          materialId: suggestion.materialId,
          title: suggestion.title,
          url: suggestion.url,
        } as const);
    setReviewDrafts((current) => ({
      ...current,
      [review.id]: { ...current[review.id]!, cover },
    }));
    setSelectedSuggestionKeys(new Set());
    setSuggestionsError("");
  }

  if (error && !job)
    return (
      <Card className="p-10 text-center">
        <CircleAlert className="mx-auto text-[#e60012]" />
        <p className="mt-4 text-sm">{error}</p>
        <Button
          className="mt-5"
          onClick={() => {
            setError("");
            setDetailReloadKey((current) => current + 1);
          }}
        >
          立即重试
        </Button>
      </Card>
    );
  if (!job)
    return (
      <Card className="p-10 text-center text-sm text-[#666a73]">
        正在读取任务详情…
      </Card>
    );
  const meta = statusMeta[job.status];
  const selectedArtifact = job.result?.channelArtifacts?.[preview];
  const savedHtml = storedChannelHtml(job, preview);
  const html = reviewPreviews[preview]?.html ?? savedHtml;
  const selectedArticle =
    job.result?.channelArticles?.[preview] ??
    selectedArtifact?.article ??
    job.result?.article;
  const selectedTemplate =
    job.templateVersions?.[preview] ??
    job.result?.channelArtifacts?.[preview]?.template;
  const previewCoverUrl =
    reviewPreviews[preview]?.coverUrl ??
    job.result?.channelArtifacts?.[preview]?.assets?.[0]?.selected?.url;
  const previewHtml =
    preview === "official_site" && html && previewCoverUrl
      ? `<figure data-gd-preview-cover="official-site" style="box-sizing:border-box;max-width:980px;margin:0 auto;background:#FFFFFF;"><img src="${escapePreviewAttribute(previewCoverUrl)}" alt="官网文章封面" style="display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border:0;" /></figure>${html}`
      : html;
  const hasRetryableTarget = job.targets.some(
    (target) => target.status === "failed",
  );
  const browserDraftTargets = job.targets.filter((target) =>
    browserDraftChannels.includes(
      target.target as (typeof browserDraftChannels)[number],
    ),
  );
  const pendingReviews = (job.reviews || []).filter(
    (review) => review.status === "pending",
  );
  const pendingReviewTargets = [
    ...new Set(pendingReviews.map((review) => review.target)),
  ];
  const visiblePendingReviews = pendingReviews.filter(
    (review) => review.target === preview,
  );
  const resolvedReviews = (job.reviews || []).filter(
    (review) => review.status !== "pending",
  );
  const activeContentReview = pendingReviews.find(
    (review) =>
      review.target === preview && review.category === "content_quality",
  );
  const initialPreviewLoading = Boolean(
    !previewHtml && activeContentReview && reviewDrafts[activeContentReview.id],
  );
  const inputTargetLabels = job.input.targets.map(
    (target) => channelNames[target],
  );
  const caseVisualLabels = (job.input.caseVisualTypes ?? []).map((type) =>
    type === "cover"
      ? "案例封面"
      : type === "function"
        ? "功能全览图"
        : type === "flow"
          ? "业务流程图"
          : type === "roles"
            ? "角色协同图"
            : "系统架构图",
  );
  return (
    <>
      <PageHeader
        eyebrow="Content Job"
        title={selectedArticle?.title || job.title || job.topic}
        description={`任务 ID：${job.id} · 创建人：${job.createdBy.name || "运营成员"}`}
        action={
          <div className="flex items-center gap-2">
            {job.canManage &&
              !terminal.has(job.status) &&
              job.status !== "publishing" && (
                <Button
                  variant="secondary"
                  onClick={() => void cancelJob()}
                  disabled={cancelling}
                >
                  <StopCircle size={16} />
                  {cancelling ? "正在取消…" : "取消任务"}
                </Button>
              )}
            {job.canManage && terminal.has(job.status) && !job.deletedAt && (
              <Button
                variant="danger"
                onClick={() => void moveToTrash()}
                disabled={deleting}
              >
                <Trash2 size={16} />
                {deleting ? "正在删除…" : "移入回收站"}
              </Button>
            )}
            <Button asChild variant="secondary">
              <Link href="/tasks">
                <ArrowLeft size={16} />
                返回任务中心
              </Link>
            </Button>
          </div>
        }
      />
      <details
        open
        aria-label="任务创建时填写的全部内容"
        className="group mb-5 overflow-hidden rounded-2xl border border-[#e2e2e6] bg-white shadow-[0_5px_18px_rgba(23,23,26,.035)]"
      >
        <summary className="focus-ring flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 sm:px-5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#fff1f2] text-[#e60012]">
            <Hash size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-bold uppercase tracking-[.12em] text-[#85858e]">
              创建时填写内容
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-[#2f2f34]">
              {job.topic}
            </span>
          </span>
          <span className="text-xs text-[#85858e] group-open:hidden">
            展开全部参数
          </span>
          <span className="hidden text-xs text-[#85858e] group-open:inline">
            收起
          </span>
        </summary>
        <div className="border-t border-[#ededf0] bg-[#fafafa] px-4 py-4 sm:px-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              [
                "内容类型",
                job.input.contentType === "case" ? "案例文章" : "通用文章",
              ],
              [
                "读者模式",
                job.input.readerMode === "professional"
                  ? "专业模式"
                  : "普适模式",
              ],
              [
                "图片策略",
                job.input.imageMode === "generated"
                  ? "AI 章节插图 + 智能候选池"
                  : "仅 GeekHome 授权素材",
              ],
              ["目标渠道", inputTargetLabels.join("、")],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3"
              >
                <p className="text-[11px] font-semibold text-[#85858e]">
                  {label}
                </p>
                <p className="mt-1 text-sm font-semibold leading-5 text-[#333339]">
                  {value}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
              <p className="text-[11px] font-semibold text-[#85858e]">
                内容主题
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[#333339]">
                {job.topic}
              </p>
            </div>
            <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
              <p className="text-[11px] font-semibold text-[#85858e]">
                用户填写标题
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[#333339]">
                {job.input.title?.trim() || "未填写，由 AI 生成标题"}
              </p>
            </div>
          </div>
          {(job.input.contentType === "case" ||
            caseVisualLabels.length > 0) && (
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
                <p className="text-[11px] font-semibold text-[#85858e]">
                  案例状态
                </p>
                <p className="mt-1 text-sm text-[#333339]">
                  {job.input.caseStatus === "delivered"
                    ? "已交付案例"
                    : "方案型案例"}
                </p>
              </div>
              <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
                <p className="text-[11px] font-semibold text-[#85858e]">
                  案例配图
                </p>
                <p className="mt-1 text-sm text-[#333339]">
                  {caseVisualLabels.join("、") || "未选择"}
                </p>
              </div>
            </div>
          )}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
              <p className="text-[11px] font-semibold text-[#85858e]">标签</p>
              <p className="mt-1 text-sm leading-6 text-[#333339]">
                一级：{job.input.primaryTag || "未填写"}
                <br />
                二级：{job.input.secondaryTags?.join("、") || "未填写"}
              </p>
            </div>
            <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
              <p className="text-[11px] font-semibold text-[#85858e]">
                补充要求
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[#333339]">
                {job.input.remarks?.trim() || "未填写"}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
              <p className="text-[11px] font-semibold text-[#85858e]">
                参考资料链接
              </p>
              {job.input.sourceRefs.length ? (
                <div className="mt-1 space-y-1.5">
                  {job.input.sourceRefs.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all text-xs leading-5 text-[#a60010] underline decoration-[#f0b6bb] underline-offset-2"
                    >
                      {url}
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm text-[#333339]">未填写</p>
              )}
            </div>
            <div className="rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-3">
              <p className="text-[11px] font-semibold text-[#85858e]">
                上传附件
              </p>
              {job.inputAttachments.length ? (
                <div className="mt-1 space-y-1.5">
                  {job.inputAttachments.map((attachment) => (
                    <p
                      key={attachment.id}
                      className="break-words text-xs leading-5 text-[#333339]"
                    >
                      {attachment.name}
                      <span className="ml-2 text-[#85858e]">
                        {formatInputBytes(attachment.bytes)}
                      </span>
                    </p>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm text-[#333339]">未上传</p>
              )}
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-[#85858e]">
            以上为任务提交时保存的原始输入；文章生成后的标题和正文不会覆盖这些记录。
          </p>
        </div>
      </details>
      {actionError && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-[#f4c7ca] bg-[#fff5f5] px-4 py-3 text-sm text-[#b90012]"
        >
          {actionError}
        </p>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.48fr)_minmax(420px,.72fr)]">
        <div className="contents">
          <Card className="p-6 xl:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="text-xs text-[#85858e]">
                    {job.progress.percent}%
                  </span>
                </div>
                <p className="mt-3 text-sm font-semibold">
                  {job.progress.message}
                </p>
              </div>
              <div className="text-right text-xs text-[#85858e]">
                最后更新
                <br />
                <strong className="text-[#55555d]">
                  {new Date(job.updatedAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </strong>
              </div>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#ededf0]">
              <div
                className="h-full rounded-full bg-[#e60012] transition-all"
                style={{ width: `${job.progress.percent}%` }}
              />
            </div>
            {job.result?.manualReviewReason && (
              <div className="mt-5 flex gap-3 rounded-2xl border border-[#f3d48d] bg-[#fff9e9] p-4 text-sm text-[#76520b]">
                <CircleAlert size={18} className="mt-0.5 shrink-0" />
                <p>{job.result.manualReviewReason}</p>
              </div>
            )}
            {job.result?.runtime && (
              <div
                className={`mt-5 rounded-2xl border p-4 text-sm ${
                  ["openrouter", "openai"].includes(
                    job.result.runtime.contentEngineMode,
                  )
                    ? "border-[#c9ead6] bg-[#f1fbf5] text-[#17693d]"
                    : "border-[#f3d48d] bg-[#fff9e9] text-[#76520b]"
                }`}
              >
                <strong className="block">
                  本次内容引擎：
                  {job.result.runtime.contentEngineMode === "openai"
                    ? "OpenAI 官方 Responses API"
                    : job.result.runtime.contentEngineMode === "openrouter"
                      ? "OpenRouter 正式模式"
                      : job.result.runtime.contentEngineMode === "mock_geekhome"
                        ? "Mock 写作 + GeekHome 素材"
                        : "本地 Mock"}
                </strong>
                <span className="mt-1 block text-xs opacity-80">
                  文本模型：{job.result.runtime.textModel} · 图片引擎：
                  {job.result.runtime.imageProviderMode === "openai"
                    ? "OpenAI 官方 Images API"
                    : job.result.runtime.imageProviderMode === "openrouter"
                      ? "OpenRouter"
                      : "本地 Mock"}
                </span>
              </div>
            )}
          </Card>
          <Card
            id="channel-preview-panel"
            className="order-3 min-w-0 scroll-mt-5 overflow-hidden xl:col-start-1 xl:row-start-3 xl:self-start"
          >
            <div className="flex items-center justify-between border-b border-[#ededf0] p-4">
              <div className="flex flex-wrap gap-2">
                {job.input.targets.map((target) => {
                  const Icon =
                    target === "official_site"
                      ? Globe2
                      : target === "wechat"
                        ? MessageCircleMore
                        : BookOpen;
                  return (
                    <button
                      key={target}
                      onClick={() => setPreview(target)}
                      className={`rounded-xl px-4 py-2 text-sm font-semibold ${preview === target ? "bg-[#17171a] text-white" : "bg-[#f5f5f6] text-[#666a73]"}`}
                    >
                      <Icon size={15} className="mr-2 inline" />
                      {channelNames[target]}预览
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                {selectedTemplate && (
                  <Badge>
                    {selectedTemplate.skillName}@{selectedTemplate.version}
                  </Badge>
                )}
                <Badge>
                  {preview === "official_site" ? "桌面版" : "手机版"}
                </Badge>
              </div>
            </div>
            <div className="min-w-0 space-y-4 bg-[#f2f2f4] p-4 sm:p-6">
              <div className="min-w-0">
                {previewHtml ? (
                  <div
                    className={
                      preview !== "official_site"
                        ? "mx-auto max-w-[430px] overflow-hidden rounded-[30px] border-[8px] border-[#17171a] bg-white shadow-xl"
                        : "mx-auto max-w-[980px] overflow-hidden rounded-2xl bg-white shadow-sm"
                    }
                  >
                    <iframe
                      key={`${preview}-${previewVersions[preview] ?? 0}`}
                      title={`${preview} preview`}
                      sandbox="allow-same-origin"
                      srcDoc={previewHtml}
                      onLoad={(event) => {
                        const document = event.currentTarget.contentDocument;
                        if (!document) return;
                        document.querySelectorAll("img").forEach((image) => {
                          image.style.cursor = "zoom-in";
                          image.onclick = () =>
                            setLightboxUrl(image.currentSrc || image.src);
                        });
                      }}
                      className={`w-full bg-white ${preview !== "official_site" ? "h-[min(920px,calc(100dvh-120px))] min-h-[720px]" : "h-[min(1100px,calc(100dvh-100px))] min-h-[820px]"}`}
                    />
                  </div>
                ) : (
                  <div className="grid min-h-[420px] place-items-center text-sm text-[#85858e]">
                    {initialPreviewLoading
                      ? "正在加载当前文章预览…"
                      : "排版产物生成后会显示在这里"}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
        <div className="order-2 min-w-0 space-y-5 overflow-x-hidden xl:col-start-1 xl:row-start-2">
          {pendingReviewTargets.length > 0 && (
            <Card className="flex flex-wrap items-center gap-2 p-2">
              {pendingReviewTargets.map((target) => {
                const label = `${channelNames[target]}复核`;
                const Icon =
                  target === "official_site"
                    ? Globe2
                    : target === "wechat"
                      ? MessageCircleMore
                      : BookOpen;
                return (
                  <button
                    key={target}
                    type="button"
                    onClick={() => setPreview(target)}
                    className={`focus-ring inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition ${preview === target ? "bg-[#17171a] text-white" : "bg-[#f5f5f6] text-[#666a73] hover:text-[#17171a]"}`}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                );
              })}
            </Card>
          )}
          {pendingReviewTargets.length > 0 &&
            visiblePendingReviews.length === 0 && (
              <Card className="p-6 text-sm text-[#666a73]">
                当前预览渠道没有待处理复核，请选择上方复核渠道。
              </Card>
            )}
          {visiblePendingReviews.map((review) => {
            const input = reviewInputs[review.id] || {
              note: "",
              externalDraftId: "",
              externalUrl: "",
            };
            const channelLabel = channelNames[review.target];
            const reviewDraft = reviewDrafts[review.id];
            const currentCoverAssetId =
              reviewDraft?.cover?.source === "asset"
                ? reviewDraft.cover.assetId
                : undefined;
            const currentCoverAsset = currentCoverAssetId
              ? reviewAssets.find((asset) => asset.id === currentCoverAssetId)
              : undefined;
            const coverSourceAssetId =
              reviewCoverAdjustments[review.id]?.sourceAssetId ||
              String(currentCoverAsset?.metadata.derivedFromAssetId ?? "");
            const coverSourceUrl =
              reviewAssets.find((asset) => asset.id === coverSourceAssetId)
                ?.fileUrl ?? null;
            const originalImageUrls = (
              job.result?.channelArtifacts?.[review.target]?.assets ?? []
            ).map((asset) => asset.selected?.url ?? null);
            return (
              <Card key={review.id} className="border-[#e3e3e7] bg-white p-5">
                <div className="flex items-center gap-2">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#fff1f2] text-[#e60012]">
                    <ClipboardCheck size={17} />
                  </span>
                  <h2 className="font-bold">{channelLabel}人工复核</h2>
                </div>
                <div className="mt-3">
                  <Badge tone="amber">
                    {review.category === "content_quality"
                      ? "内容质量复核"
                      : "渠道结果确认"}
                  </Badge>
                </div>
                <div className="mt-3 rounded-xl border border-[#f3d48d] bg-[#fff9e9] px-3.5 py-3">
                  <p className="text-xs leading-5 text-[#76520b]">
                    {review.reason}
                  </p>
                  {review.reasonCode && (
                    <p className="mt-1.5 break-all font-mono text-[10px] text-[#9b6300]">
                      {review.reasonCode}
                    </p>
                  )}
                </div>
                {review.category === "content_quality" && reviewDraft && (
                  <ManualReviewEditor
                    channel={review.target}
                    draft={reviewDraft}
                    originalImageUrls={originalImageUrls}
                    assets={reviewAssets}
                    busySlotIndex={
                      reviewImageBusy?.reviewId === review.id
                        ? reviewImageBusy.slotIndex
                        : null
                    }
                    busyAction={
                      reviewImageBusy?.reviewId === review.id
                        ? reviewImageBusy.action
                        : undefined
                    }
                    uploadFeedback={reviewImageFeedback[review.id]}
                    onChange={(draft) =>
                      setReviewDrafts((current) => ({
                        ...current,
                        [review.id]: draft,
                      }))
                    }
                    onUpload={(file, placement, replaceIndex) =>
                      void uploadReviewAsset(
                        review.id,
                        file,
                        placement,
                        replaceIndex,
                      )
                    }
                    onCrop={(slotIndex, ratio, region) =>
                      void cropReviewAsset(review.id, slotIndex, ratio, region)
                    }
                    onCoverUpload={(file) =>
                      void uploadReviewCover(review.id, file)
                    }
                    coverSourceUrl={coverSourceUrl}
                    onCoverCrop={(target, region) =>
                      void cropReviewCover(review.id, target, region)
                    }
                    onPreview={() => void previewManualReview(review.id)}
                    previewState={reviewPreviewStates[review.id]}
                    onActivePlacementChange={(placement) => {
                      setPreview(review.target);
                      setReviewInsertPlacements((current) => ({
                        ...current,
                        [review.id]: placement,
                      }));
                    }}
                  />
                )}
                {review.category === "content_quality" && !reviewDraft && (
                  <p className="mt-4 rounded-xl border border-[#f6b8be] bg-[#fff1f2] p-3 text-xs text-[#b90012]">
                    文章结构未加载，暂时不能通过审核。请刷新页面；如果仍然出现，请重新生成该任务。
                  </p>
                )}
                {review.category === "delivery_uncertain" &&
                  review.target !== "xiaohongshu" && (
                    <div className="mt-4 grid gap-3">
                      <input
                        className={inputClass}
                        value={input.externalDraftId}
                        placeholder="渠道草稿 ID（选填）"
                        onChange={(event) =>
                          setReviewInputs((current) => ({
                            ...current,
                            [review.id]: {
                              ...input,
                              externalDraftId: event.target.value,
                            },
                          }))
                        }
                      />
                      <input
                        className={inputClass}
                        type="url"
                        value={input.externalUrl}
                        placeholder="渠道草稿 HTTPS 地址（选填）"
                        onChange={(event) =>
                          setReviewInputs((current) => ({
                            ...current,
                            [review.id]: {
                              ...input,
                              externalUrl: event.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  )}
                <p className="mt-2 text-[11px] leading-5 text-[#7a6a45]">
                  {review.category === "content_quality"
                    ? "通过时会保存上方复核版本，并只创建当前渠道草稿；驳回不会产生任何渠道写入。"
                    : review.target === "xiaohongshu"
                      ? "点击后会使用当前电脑已登录的小红书账号，自动上传图片并填写内容；填写完成后请在小红书页面人工点击“暂存离开”。"
                      : "请先到渠道后台核对。确认草稿存在不会调用渠道；仅确认不存在后才会重试。"}
                </p>
                {reviewActionErrors[review.id] && (
                  <p
                    role="alert"
                    className="mt-3 rounded-xl border border-[#f6b8be] bg-[#fff1f2] p-3 text-xs text-[#b90012]"
                  >
                    {reviewActionErrors[review.id]}
                  </p>
                )}
                <div className="mt-4 grid gap-2">
                  {review.category === "content_quality" ? (
                    <>
                      <Button
                        type="button"
                        disabled={
                          resolvingReview === review.id ||
                          !reviewDraft ||
                          reviewImageBusy?.reviewId === review.id
                        }
                        onClick={() =>
                          void resolveManualReview(review.id, "approve_content")
                        }
                      >
                        {resolvingReview === review.id
                          ? review.target === "xiaohongshu"
                            ? "正在上传并填写小红书内容…"
                            : "正在提交复核…"
                          : review.target === "xiaohongshu"
                            ? "通过复核并上传到小红书"
                            : browserDraftChannels.includes(
                                  review.target as (typeof browserDraftChannels)[number],
                                )
                              ? `通过复核并保存到${channelLabel}`
                              : `通过并创建${channelLabel}草稿`}
                      </Button>
                      {review.target !== "xiaohongshu" && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={resolvingReview === review.id}
                          onClick={() =>
                            void resolveManualReview(
                              review.id,
                              "reject_content",
                            )
                          }
                        >
                          驳回并停止该渠道
                        </Button>
                      )}
                    </>
                  ) : review.target === "xiaohongshu" ? (
                    <Button
                      type="button"
                      disabled={resolvingReview === review.id}
                      onClick={() =>
                        void resolveManualReview(
                          review.id,
                          "confirm_absent_retry",
                        )
                      }
                    >
                      {resolvingReview === review.id
                        ? "正在上传并填写小红书内容…"
                        : "上传并填写到小红书"}
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        disabled={resolvingReview === review.id}
                        onClick={() =>
                          void resolveManualReview(review.id, "confirm_drafted")
                        }
                      >
                        {resolvingReview === review.id
                          ? "正在提交复核…"
                          : "确认草稿已存在"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={resolvingReview === review.id}
                        onClick={() =>
                          void resolveManualReview(
                            review.id,
                            "confirm_absent_retry",
                          )
                        }
                      >
                        确认未创建并安全重试
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
          {resolvedReviews.length > 0 && (
            <Card className="p-6">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={18} className="text-[#187844]" />
                <h2 className="font-bold">复核记录</h2>
              </div>
              <div className="mt-4 space-y-3">
                {resolvedReviews.map((review) => {
                  const channelLabel = channelNames[review.target];
                  const statusLabel =
                    review.status === "approved"
                      ? "已通过并提交草稿创建"
                      : review.status === "rejected"
                        ? "已驳回"
                        : review.status === "confirmed_drafted"
                          ? "已确认草稿存在"
                          : "已确认并重试";
                  return (
                    <div
                      key={review.id}
                      className="rounded-xl border border-[#ededf0] p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong>
                          {channelLabel} · {statusLabel}
                        </strong>
                        {review.resolvedAt && (
                          <span className="text-[11px] text-[#85858e]">
                            {new Date(review.resolvedAt).toLocaleString(
                              "zh-CN",
                              { hour12: false },
                            )}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-[#85858e]">
                        复核人：{review.reviewer?.name || "运营成员"}
                        {review.revisionApplied ? " · 已保存复核修改" : ""}
                      </p>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
          {browserDraftTargets.map((target) => {
            const channel =
              target.target as (typeof browserDraftChannels)[number];
            const channelName = channelNames[channel];
            const isXiaohongshu = channel === "xiaohongshu";
            return (
              <Card key={channel} className="border-[#f6b8be] bg-[#fffafb] p-6">
                <div className="flex items-center gap-2">
                  <Laptop size={18} className="text-[#e60012]" />
                  <h2 className="font-bold">{channelName}草稿箱</h2>
                </div>
                <p className="mt-3 text-xs leading-5 text-[#666a73]">
                  {isXiaohongshu
                    ? "使用当前电脑已登录的小红书账号上传图片并填写标题、正文和横向话题；填写完成后人工点击“暂存离开”。"
                    : `使用当前电脑已登录的${channelName}账号，自动填写已复核的标题、正文和配图；只有识别到唯一的“保存草稿”按钮时才会自动保存，绝不会点击正式发布。`}
                </p>
                {target.uploadTask?.status === "waiting_for_uploader" &&
                  job.canManage && (
                    <>
                      <Button
                        className="mt-4 w-full"
                        onClick={() =>
                          void startBrowserDraftUpload(
                            target.uploadTask!.id,
                            channel,
                          )
                        }
                        disabled={startingXiaohongshu}
                      >
                        {startingXiaohongshu
                          ? "正在填写并保存…"
                          : `保存到${channelName}草稿箱`}
                      </Button>
                      {xiaohongshuProgress && (
                        <p className="mt-3 rounded-xl border border-[#f3d48d] bg-white px-3 py-2 text-xs text-[#76520b]">
                          {xiaohongshuProgress}
                        </p>
                      )}
                    </>
                  )}
                {target.uploadTask?.status === "waiting_for_uploader" &&
                  !job.canManage && (
                    <p className="mt-3 rounded-xl bg-white px-3 py-2 text-xs text-[#666a73]">
                      当前为团队只读任务，请由任务创建人或管理员保存到
                      {channelName}草稿箱。
                    </p>
                  )}
                {target.uploadTask?.status === "filled" && (
                  <p className="mt-4 rounded-xl border border-[#c9ead6] bg-white px-3 py-3 text-xs font-semibold leading-5 text-[#17693d]">
                    内容已填写到{channelName}创作页，请检查后人工保存草稿。
                  </p>
                )}
                {target.uploadTask?.status === "drafted" && (
                  <p className="mt-4 rounded-xl border border-[#c9ead6] bg-white px-3 py-3 text-xs font-semibold leading-5 text-[#17693d]">
                    已检测到明确的草稿保存成功提示。
                  </p>
                )}
                <Link
                  href="/channels"
                  className="mt-4 inline-flex text-xs font-semibold text-[#e60012] hover:underline"
                >
                  管理当前电脑的多平台草稿助手
                </Link>
              </Card>
            );
          })}
        </div>
        <aside className="order-4 min-w-0 space-y-5 xl:col-start-2 xl:row-span-2 xl:row-start-2 xl:self-start">
          <SmartImagePanel
            suggestions={imageSuggestions}
            loading={suggestionsLoading}
            error={suggestionsError}
            warning={suggestionsWarning}
            generation={imageGeneration}
            filter={suggestionFilter}
            canInsert={Boolean(activeContentReview)}
            busy={smartImageUploading || reviewImageBusy !== null}
            startingGeneration={startingImageGeneration}
            onFilterChange={setSuggestionFilter}
            onUpload={(file) => void uploadSmartImage(file)}
            onGenerate={() => void startImageCandidateGeneration()}
            onInsert={addSuggestedImage}
            selectedKeys={selectedSuggestionKeys}
            onToggleSelected={toggleSuggestedImage}
            onInsertSelected={insertSelectedSuggestions}
            onUseAsCover={useSelectedSuggestionAsCover}
            hasSelectedCover={Boolean(
              activeContentReview &&
              reviewDrafts[activeContentReview.id]?.cover,
            )}
            onZoom={setLightboxUrl}
          />
          <Card className="p-5">
            <h2 className="font-bold">证据清单</h2>
            <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-1">
              {job.evidence.length ? (
                job.evidence.map((item) => (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-xl border border-[#ededf0] p-3 transition hover:border-[#f6b8be]"
                  >
                    <span className="flex items-start justify-between gap-2 text-xs font-semibold leading-5">
                      {item.title}
                      <ExternalLink
                        size={13}
                        className="mt-1 shrink-0 text-[#e60012]"
                      />
                    </span>
                    <span className="mt-1 block text-[11px] text-[#85858e]">
                      {item.sourceType} · {item.claims.length} 项可追溯信息
                    </span>
                  </a>
                ))
              ) : (
                <p className="text-xs text-[#85858e]">正在建立证据清单…</p>
              )}
            </div>
          </Card>
          <Card className="p-5">
            <h2 className="font-bold">渠道结果</h2>
            <div className="mt-4 space-y-3">
              {job.targets.map((target) => (
                <div
                  key={target.target}
                  className="rounded-xl bg-[#f7f7f8] p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {target.target === "official_site" ? (
                        <Globe2 size={16} />
                      ) : target.target === "wechat" ? (
                        <MessageCircleMore size={16} />
                      ) : (
                        <BookOpen size={16} />
                      )}
                      {channelNames[target.target]}
                    </div>
                    <Badge
                      tone={
                        target.status === "drafted"
                          ? "green"
                          : target.status === "manual_review"
                            ? "amber"
                            : "neutral"
                      }
                    >
                      {target.status === "manual_review"
                        ? "人工复核"
                        : target.status === "waiting_for_uploader"
                          ? "等待扩展"
                          : target.status === "uploading"
                            ? "正在上传"
                            : target.status === "filled"
                              ? "已上传完成，等待人工暂存"
                              : target.status}
                    </Badge>
                  </div>
                  {job.templateVersions?.[target.target] && (
                    <p className="mt-2 break-all text-[11px] text-[#85858e]">
                      执行模板：
                      {job.templateVersions[target.target]?.skillName}@
                      {job.templateVersions[target.target]?.version}
                    </p>
                  )}
                  {target.errorCode && (
                    <p className="mt-2 break-all text-[11px] text-[#b35d00]">
                      错误码：{target.errorCode}
                    </p>
                  )}
                  {target.externalUrl && target.status === "drafted" && (
                    <a
                      href={target.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#e60012] hover:underline"
                    >
                      打开渠道后台草稿
                      <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              ))}
            </div>
            {job.canManage && hasRetryableTarget && (
              <Button
                type="button"
                className="mt-4 w-full"
                onClick={retryFailedTargets}
                disabled={retrying}
              >
                <RotateCcw size={15} />
                {retrying ? "正在提交…" : "仅重试失败渠道"}
              </Button>
            )}
          </Card>
        </aside>
      </div>
      {lightboxUrl && (
        <button
          type="button"
          aria-label="关闭图片放大预览"
          onClick={() => setLightboxUrl("")}
          className="fixed inset-0 z-[100] grid cursor-zoom-out place-items-center bg-black/80 p-6 backdrop-blur-sm"
        >
          <img
            src={lightboxUrl}
            alt="放大预览"
            className="max-h-[92dvh] max-w-[92vw] rounded-xl object-contain shadow-2xl"
          />
        </button>
      )}
    </>
  );
}
