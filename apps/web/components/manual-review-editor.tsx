"use client";

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  Crop,
  Eye,
  ImagePlus,
  LoaderCircle,
  Replace,
  Trash2,
} from "lucide-react";
import type {
  ArticleImagePlacement,
  Channel,
  ReviewableArticle,
} from "@/lib/content";
import {
  ManualReviewCropDialog,
  type CropRatio,
  type CropRegion,
} from "@/components/manual-review-crop-dialog";

export type ReviewAsset = {
  id: string;
  fileUrl: string | null;
  status: string;
  metadata: Record<string, unknown>;
};

type ReviewImageSource =
  | { source: "existing"; url: string }
  | { source: "asset"; assetId: string }
  | { source: "suggestion"; materialId: string; title: string; url: string };

export type ReviewImageSlot =
  (ReviewImageSource & { placement?: ArticleImagePlacement }) | null;

export type ReviewDraft = {
  article: ReviewableArticle;
  images: ReviewImageSlot[];
  cover?: ReviewImageSlot;
};

export type WechatCoverCropTarget = "wide" | "square";

const splitLines = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

function sectionHeading(value: string) {
  return value
    .replace(
      /^\s*(?:(?:第\s*)?[一二三四五六七八九十百]+\s*[、.．:：)）-]\s*|\d{1,2}\s*[、.．:：)）\]-]\s*|\d{1,2}\s+)/u,
      "",
    )
    .trim();
}

function defaultSummaryPoints(article: ReviewableArticle) {
  return article.sections.slice(0, 3).map((section) => {
    const heading = sectionHeading(section.heading) || section.heading.trim();
    const detail = (section.bullets[0] || section.paragraphs[0] || "").trim();
    return detail && !detail.includes(heading)
      ? `${heading}：${detail}`
      : heading;
  }) as [string, string, string];
}

const AutoResizeTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AutoResizeTextarea({ value, onInput, ...props }, forwardedRef) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    const element = localRef.current;
    if (!element) return;
    resize(element);
    const observer = new ResizeObserver(() => resize(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);
  return (
    <textarea
      {...props}
      value={value}
      ref={(element) => {
        localRef.current = element;
        if (typeof forwardedRef === "function") forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      }}
      rows={1}
      onInput={(event) => {
        resize(event.currentTarget);
        onInput?.(event);
      }}
    />
  );
});

function BulletTextarea({
  bullets,
  onBulletsChange,
  ...props
}: Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
> & {
  bullets: string[];
  onBulletsChange: (bullets: string[]) => void;
}) {
  const externalValue = bullets.join("\n");
  const [draftValue, setDraftValue] = useState(externalValue);

  useEffect(() => {
    setDraftValue((current) =>
      splitLines(current).join("\n") === externalValue
        ? current
        : externalValue,
    );
  }, [externalValue]);

  return (
    <AutoResizeTextarea
      {...props}
      value={draftValue}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setDraftValue(value);
        onBulletsChange(splitLines(value));
      }}
    />
  );
}

function placementKey(placement?: ArticleImagePlacement) {
  if (!placement) return "";
  if (placement.anchor === "after_opening")
    return `${placement.anchor}:${placement.paragraphIndex}`;
  if ("sectionIndex" in placement) {
    if (placement.anchor === "after_section_paragraph")
      return `${placement.anchor}:${placement.sectionIndex}:${placement.paragraphIndex}`;
    return `${placement.anchor}:${placement.sectionIndex}`;
  }
  return placement.anchor;
}

function imageUrl(image: ReviewImageSlot | undefined, assets: ReviewAsset[]) {
  if (!image) return null;
  if (image.source === "existing" || image.source === "suggestion")
    return image.url;
  return assets.find((asset) => asset.id === image.assetId)?.fileUrl ?? null;
}

function InlineImage({
  index,
  draft,
  assets,
  busy,
  onChange,
  onUpload,
  onCrop,
}: {
  index: number;
  draft: ReviewDraft;
  assets: ReviewAsset[];
  busy: boolean;
  onChange: (draft: ReviewDraft) => void;
  onUpload: (
    file: File,
    placement: ArticleImagePlacement,
    replaceIndex?: number,
  ) => void;
  onCrop: (slotIndex: number, ratio: CropRatio, region: CropRegion) => void;
}) {
  const image = draft.images[index];
  const url = imageUrl(image, assets);
  const [cropOpen, setCropOpen] = useState(false);
  const [ratio, setRatio] = useState<CropRatio>("4:3");
  const replaceInput = useRef<HTMLInputElement>(null);
  if (!image || !url) return null;
  return (
    <figure className="group relative my-6 overflow-hidden rounded-2xl border border-[#e7e7ea] bg-[#f6f6f7]">
      <img
        src={url}
        alt="文章配图"
        className="max-h-[560px] w-full object-contain"
      />
      <div className="absolute right-3 top-3 flex gap-1.5 rounded-xl bg-[#17171a]/85 p-1.5 opacity-100 shadow-lg backdrop-blur transition md:translate-y-[-4px] md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100 md:group-focus-within:translate-y-0 md:group-focus-within:opacity-100">
        <select
          aria-label="裁剪比例"
          value={ratio}
          onChange={(event) => setRatio(event.target.value as CropRatio)}
          className="h-8 rounded-lg border-0 bg-white px-2 text-[11px] text-[#333339]"
        >
          <option value="16:9">16:9</option>
          <option value="4:3">4:3</option>
          <option value="3:4">3:4</option>
          <option value="1:1">1:1</option>
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => setCropOpen(true)}
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-white hover:bg-white/15"
          title="手动裁剪"
        >
          <Crop size={15} />
          裁剪
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => replaceInput.current?.click()}
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-white hover:bg-white/15"
          title="替换图片"
        >
          <Replace size={15} />
          替换
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onChange({
              ...draft,
              images: draft.images.filter(
                (_, itemIndex) => itemIndex !== index,
              ),
            })
          }
          className="grid h-8 w-8 place-items-center rounded-lg text-white hover:bg-[#e60012]"
          title="删除图片"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <input
        ref={replaceInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file)
            onUpload(
              file,
              image.placement ?? { anchor: "after_summary" },
              index,
            );
          event.target.value = "";
        }}
      />
      {cropOpen && (
        <ManualReviewCropDialog
          imageUrl={url}
          initialRatio={ratio}
          busy={busy}
          onClose={() => !busy && setCropOpen(false)}
          onConfirm={(region, selectedRatio) => {
            onCrop(index, selectedRatio, region);
            setCropOpen(false);
          }}
        />
      )}
    </figure>
  );
}

export function ManualReviewEditor({
  draft,
  channel,
  assets,
  busySlotIndex,
  busyAction,
  uploadFeedback,
  onChange,
  onUpload,
  onCrop,
  onCoverUpload,
  coverSourceUrl,
  onCoverCrop,
  onPreview,
  previewState,
  onActivePlacementChange,
}: {
  draft: ReviewDraft;
  originalImageUrls: Array<string | null>;
  assets: ReviewAsset[];
  busySlotIndex: number | null;
  busyAction?: "upload" | "crop";
  uploadFeedback?: Record<
    number,
    { tone: "success" | "error"; message: string }
  >;
  onChange: (draft: ReviewDraft) => void;
  onUpload: (
    file: File,
    placement: ArticleImagePlacement,
    replaceIndex?: number,
  ) => void;
  onCrop: (slotIndex: number, ratio: CropRatio, region: CropRegion) => void;
  onCoverUpload: (file: File) => void;
  coverSourceUrl?: string | null;
  onCoverCrop?: (target: WechatCoverCropTarget, region: CropRegion) => void;
  onPreview: () => void;
  previewState?: {
    status: "idle" | "loading" | "success" | "error";
    message?: string;
  };
  onActivePlacementChange?: (placement: ArticleImagePlacement) => void;
  channel: Channel;
}) {
  const busy = busySlotIndex !== null;
  const coverInput = useRef<HTMLInputElement>(null);
  const coverUrl = imageUrl(draft.cover, assets);
  const [coverCropTarget, setCoverCropTarget] =
    useState<WechatCoverCropTarget | null>(null);
  const latestFeedback = Object.values(uploadFeedback ?? {}).at(-1);
  const [activePlacement, setActivePlacement] = useState<ArticleImagePlacement>(
    { anchor: "after_summary" },
  );
  const updateArticle = (article: ReviewableArticle) =>
    onChange({ ...draft, article });
  const imagesByPlacement = useMemo(() => {
    const map = new Map<string, number[]>();
    draft.images.forEach((image, index) => {
      if (!image) return;
      const key = placementKey(
        image.placement ??
          (index === 0 ? { anchor: "cover" } : { anchor: "after_summary" }),
      );
      map.set(key, [...(map.get(key) ?? []), index]);
    });
    return map;
  }, [draft.images]);
  const activate = (placement: ArticleImagePlacement) => {
    setActivePlacement(placement);
    onActivePlacementChange?.(placement);
  };
  const renderImages = (placement: ArticleImagePlacement) =>
    (imagesByPlacement.get(placementKey(placement)) ?? []).map((index) => {
      const image = draft.images[index];
      const identity = image
        ? image.source === "asset"
          ? image.assetId
          : image.source === "suggestion"
            ? image.materialId
            : image.url
        : String(index);
      return (
        <InlineImage
          key={`${identity}-${placementKey(placement)}`}
          index={index}
          draft={draft}
          assets={assets}
          busy={busy}
          onChange={onChange}
          onUpload={onUpload}
          onCrop={onCrop}
        />
      );
    });
  const textareaClass =
    "block min-h-8 w-full min-w-0 resize-none whitespace-pre-wrap break-words overflow-hidden [overflow-wrap:anywhere] border-0 bg-transparent p-0 text-[15px] leading-8 text-[#3f3f46] outline-none placeholder:text-[#b0b0b7] focus:ring-0";

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-[#dedee3] bg-white shadow-[0_12px_34px_rgba(23,23,26,.06)]">
      <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-[#ededf0] bg-white/95 px-5 py-3 backdrop-blur">
        <div>
          <h2 className="text-sm font-bold text-[#17171a]">文章编辑器</h2>
          <p className="mt-0.5 text-[11px] text-[#85858e]">
            点击正文位置后，可从智能配图插入到当前位置
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || previewState?.status === "loading"}
            onClick={onPreview}
            className={`focus-ring inline-flex h-9 items-center gap-1.5 rounded-xl bg-[#17171a] px-3 text-xs font-semibold text-white hover:bg-[#e60012] disabled:opacity-60 ${previewState?.status === "loading" ? "cursor-wait" : ""}`}
          >
            {previewState?.status === "loading" ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : previewState?.status === "success" ? (
              <CheckCircle2 size={14} />
            ) : (
              <Eye size={14} />
            )}
            {previewState?.status === "loading"
              ? "正在生成预览…"
              : "预览当前修改"}
          </button>
        </div>
      </header>
      {previewState?.status === "success" && previewState.message && (
        <p
          role="status"
          className="border-b border-[#d4eadc] bg-[#f1fbf5] px-5 py-2 text-xs text-[#17693d]"
        >
          {previewState.message}
        </p>
      )}
      {previewState?.status === "error" && previewState.message && (
        <p
          role="alert"
          className="border-b border-[#f6b8be] bg-[#fff1f2] px-5 py-2 text-xs text-[#b90012]"
        >
          {previewState.message}
        </p>
      )}
      {(busy || latestFeedback) && (
        <p
          role={latestFeedback?.tone === "error" ? "alert" : "status"}
          className={`border-b px-5 py-2 text-xs ${latestFeedback?.tone === "error" ? "border-[#f6b8be] bg-[#fff1f2] text-[#b90012]" : "border-[#d4eadc] bg-[#f1fbf5] text-[#17693d]"}`}
        >
          {busy
            ? busyAction === "crop"
              ? "正在生成裁剪后的图片…"
              : channel === "wechat" && busySlotIndex === -1
                ? "正在上传并生成 2.35:1 + 1:1 公众号品牌封面…"
                : "正在上传并插入图片…"
            : latestFeedback?.message}
        </p>
      )}
      {channel === "wechat" && (
        <div className="border-b border-[#ededf0] bg-[#fafafa] px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-[#17171a]">
                公众号真实封面
              </h3>
              <p className="mt-1 text-xs leading-5 text-[#666a73]">
                上传一张真实图片后立即生成顶部带淡红渐变与 GeekDance 标识的
                2.35:1 首图和 1:1 次图，并在复核页预览合成结果。
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => coverInput.current?.click()}
              className="focus-ring inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-[#e3e3e7] bg-white px-4 text-xs font-semibold text-[#29292e] hover:border-[#f0a7ad] hover:text-[#b90012]"
            >
              <ImagePlus size={15} />
              {draft.cover ? "替换封面原图" : "上传封面原图"}
            </button>
            <input
              ref={coverInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) onCoverUpload(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
          {coverUrl && (
            <figure className="mt-4 overflow-hidden rounded-2xl border border-[#e3e3e7] bg-white p-3 shadow-sm">
              <img
                src={coverUrl}
                alt="公众号 2.35:1 与 1:1 品牌封面合成预览"
                className="mx-auto block max-h-[520px] w-auto max-w-full rounded-xl object-contain"
              />
              <figcaption className="mt-2 text-center text-xs leading-5 text-[#17693d]">
                已完成 2.35:1 首图 + 1:1 次图裁剪、品牌渐变与 GeekDance
                字标处理；通过复核后将使用这一版封面。
              </figcaption>
              {coverSourceUrl && onCoverCrop && (
                <div className="mt-3 flex flex-wrap justify-center gap-2 border-t border-[#ededf0] pt-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setCoverCropTarget("wide")}
                    className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#dedee3] bg-white px-3 text-xs font-semibold text-[#333339] hover:border-[#e60012] hover:text-[#b90012] disabled:opacity-45"
                  >
                    <Crop size={14} />
                    调整 2.35:1 首图选区
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setCoverCropTarget("square")}
                    className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#dedee3] bg-white px-3 text-xs font-semibold text-[#333339] hover:border-[#e60012] hover:text-[#b90012] disabled:opacity-45"
                  >
                    <Crop size={14} />
                    调整 1:1 次图选区
                  </button>
                </div>
              )}
            </figure>
          )}
          {coverCropTarget && coverSourceUrl && onCoverCrop && (
            <ManualReviewCropDialog
              imageUrl={coverSourceUrl}
              initialRatio={coverCropTarget === "wide" ? "2.35:1" : "1:1"}
              allowedRatios={[coverCropTarget === "wide" ? "2.35:1" : "1:1"]}
              busy={busy}
              onClose={() => !busy && setCoverCropTarget(null)}
              onConfirm={(region) => {
                onCoverCrop(coverCropTarget, region);
                setCoverCropTarget(null);
              }}
            />
          )}
        </div>
      )}
      <article className="mx-auto max-w-[860px] px-6 py-9 sm:px-10 lg:px-14">
        {renderImages({ anchor: "cover" })}
        <AutoResizeTextarea
          aria-label="文章标题"
          value={draft.article.title}
          maxLength={120}
          onFocus={() => activate({ anchor: "after_summary" })}
          onChange={(event) =>
            updateArticle({ ...draft.article, title: event.target.value })
          }
          className="block w-full min-w-0 resize-none whitespace-pre-wrap break-words overflow-hidden [overflow-wrap:anywhere] border-0 bg-transparent p-0 text-3xl font-black leading-tight tracking-[-.03em] text-[#17171a] outline-none focus:ring-0"
        />
        <AutoResizeTextarea
          aria-label="文章摘要"
          value={draft.article.description}
          maxLength={500}
          onFocus={() => activate({ anchor: "after_summary" })}
          onChange={(event) =>
            updateArticle({ ...draft.article, description: event.target.value })
          }
          className="mt-5 block w-full resize-none rounded-xl border-0 bg-[#f6f6f7] px-4 py-3 text-sm leading-6 text-[#666a73] outline-none focus:bg-[#f3f3f5] focus:ring-1 focus:ring-[#e9aab0]"
        />
        {renderImages({ anchor: "after_summary" })}

        <div className="mt-8 space-y-4">
          {draft.article.opening.map((paragraph, paragraphIndex) => (
            <div key={paragraphIndex}>
              <AutoResizeTextarea
                aria-label={`开篇第 ${paragraphIndex + 1} 段`}
                value={paragraph}
                onFocus={() =>
                  activate({ anchor: "after_opening", paragraphIndex })
                }
                onChange={(event) => {
                  const opening = [...draft.article.opening];
                  opening[paragraphIndex] = event.target.value;
                  updateArticle({ ...draft.article, opening });
                }}
                className={textareaClass}
              />
              {renderImages({ anchor: "after_opening", paragraphIndex })}
            </div>
          ))}
        </div>

        {draft.article.sections.map((section, sectionIndex) => (
          <section key={sectionIndex} className="mt-10">
            {renderImages({ anchor: "before_section", sectionIndex })}
            <AutoResizeTextarea
              aria-label={`章节 ${sectionIndex + 1} 标题`}
              value={section.heading}
              onFocus={() =>
                activate({ anchor: "after_section_heading", sectionIndex })
              }
              onChange={(event) => {
                const sections = [...draft.article.sections];
                sections[sectionIndex] = {
                  ...section,
                  heading: event.target.value,
                };
                updateArticle({ ...draft.article, sections });
              }}
              className="block w-full min-w-0 resize-none whitespace-pre-wrap break-words overflow-hidden [overflow-wrap:anywhere] border-0 bg-transparent p-0 text-xl font-black leading-8 text-[#202025] outline-none focus:ring-0"
            />
            {renderImages({ anchor: "after_section_heading", sectionIndex })}
            <div className="mt-4 space-y-4">
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <div key={paragraphIndex}>
                  <AutoResizeTextarea
                    aria-label={`章节 ${sectionIndex + 1} 第 ${paragraphIndex + 1} 段`}
                    value={paragraph}
                    onFocus={() =>
                      activate({
                        anchor: "after_section_paragraph",
                        sectionIndex,
                        paragraphIndex,
                      })
                    }
                    onChange={(event) => {
                      const sections = [...draft.article.sections];
                      const paragraphs = [...section.paragraphs];
                      paragraphs[paragraphIndex] = event.target.value;
                      sections[sectionIndex] = { ...section, paragraphs };
                      updateArticle({ ...draft.article, sections });
                    }}
                    className={textareaClass}
                  />
                  {renderImages({
                    anchor: "after_section_paragraph",
                    sectionIndex,
                    paragraphIndex,
                  })}
                </div>
              ))}
            </div>
            <BulletTextarea
              aria-label={`章节 ${sectionIndex + 1} 要点`}
              bullets={section.bullets}
              placeholder="每行一个要点"
              onFocus={() =>
                activate({ anchor: "after_section", sectionIndex })
              }
              onBulletsChange={(bullets) => {
                const sections = [...draft.article.sections];
                sections[sectionIndex] = {
                  ...section,
                  bullets,
                };
                updateArticle({ ...draft.article, sections });
              }}
              className="mt-4 block min-h-14 w-full min-w-0 resize-none whitespace-pre-wrap break-words overflow-hidden [overflow-wrap:anywhere] rounded-xl border border-[#f4c9cd] bg-[#fff7f8] px-4 py-3 text-sm leading-7 text-[#4a3b3d] outline-none focus:border-[#e9aab0] focus:ring-1 focus:ring-[#e9aab0]"
            />
            {renderImages({ anchor: "after_section", sectionIndex })}
          </section>
        ))}

        {renderImages({ anchor: "before_observation" })}
        <AutoResizeTextarea
          aria-label="观察板块标题"
          value={draft.article.observationTitle || "极客跳动观察"}
          onFocus={() => activate({ anchor: "before_observation" })}
          onChange={(event) =>
            updateArticle({
              ...draft.article,
              observationTitle: event.target.value,
            })
          }
          className="mt-10 block min-h-9 w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-xl font-black leading-8 outline-none [overflow-wrap:anywhere] focus:ring-0"
        />
        <AutoResizeTextarea
          aria-label="观察板块内容"
          value={draft.article.observation}
          onFocus={() => activate({ anchor: "before_conclusion" })}
          onChange={(event) =>
            updateArticle({ ...draft.article, observation: event.target.value })
          }
          className={`${textareaClass} mt-4`}
        />
        {renderImages({ anchor: "before_conclusion" })}
        <h2 className="mt-10 text-xl font-black">总结</h2>
        <AutoResizeTextarea
          aria-label="总结"
          value={draft.article.conclusion}
          onFocus={() => activate({ anchor: "before_conclusion" })}
          onChange={(event) =>
            updateArticle({ ...draft.article, conclusion: event.target.value })
          }
          className={`${textareaClass} mt-4`}
        />
        {channel === "wechat" && (
          <div
            data-review-summary-points="3"
            className="mt-5 space-y-3 rounded-2xl border border-[#ececef] bg-[#fafafa] px-4 py-4"
          >
            {(
              draft.article.summaryPoints ?? defaultSummaryPoints(draft.article)
            ).map((point, pointIndex) => (
              <div
                key={pointIndex}
                className="grid min-w-0 grid-cols-[34px_minmax(0,1fr)] items-start gap-2"
              >
                <span className="pt-1 text-sm font-black leading-7 text-[#e60012]">
                  {String(pointIndex + 1).padStart(2, "0")}
                </span>
                <AutoResizeTextarea
                  aria-label={`总结要点 ${pointIndex + 1}`}
                  value={point}
                  maxLength={120}
                  onFocus={() => activate({ anchor: "before_conclusion" })}
                  onChange={(event) => {
                    const summaryPoints = [
                      ...(draft.article.summaryPoints ??
                        defaultSummaryPoints(draft.article)),
                    ] as [string, string, string];
                    summaryPoints[pointIndex] = event.target.value;
                    updateArticle({ ...draft.article, summaryPoints });
                  }}
                  className="block min-h-7 w-full min-w-0 resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-sm leading-7 text-[#4b4b4f] outline-none [overflow-wrap:anywhere] focus:ring-0"
                />
              </div>
            ))}
          </div>
        )}
        <AutoResizeTextarea
          aria-label="行动建议"
          value={draft.article.cta}
          onFocus={() => activate({ anchor: "before_conclusion" })}
          onChange={(event) =>
            updateArticle({ ...draft.article, cta: event.target.value })
          }
          className="mt-6 block w-full resize-none rounded-xl border-0 bg-[#17171a] px-5 py-4 text-sm leading-7 text-white outline-none focus:ring-2 focus:ring-[#e60012]"
        />
      </article>
    </section>
  );
}
