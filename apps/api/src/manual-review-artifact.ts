import {
  validateOfficialHtml,
  validateWechatDraftFields,
  validateWechatDraftHtml,
} from "@geekdance/channel-adapters";
import {
  buildXiaohongshuNote,
  renderWechatHtml,
  renderWebsiteHtml,
  renderXiaohongshuHtml,
  type PlacedArticleImage,
} from "@geekdance/content-engine";
import type {
  ArticleImagePlacement,
  Channel,
  CoreArticle,
} from "@geekdance/shared";

export type ReviewedImage = {
  id?: string;
  title: string;
  url: string;
  metadata?: Record<string, unknown>;
  placement?: ArticleImagePlacement;
};

export function applyManualReviewRevision(input: {
  result: Record<string, any>;
  target: Channel;
  article: CoreArticle;
  images: ReviewedImage[];
  cover?: ReviewedImage;
  request: Record<string, any>;
}) {
  const { target, article, images, cover } = input;
  const artifact = input.result?.channelArtifacts?.[target];
  if (!artifact) throw new Error("REVIEW_ARTIFACT_MISSING");
  const coverIndex = images.findIndex(
    (image) => image.placement?.anchor === "cover",
  );
  const effectiveCoverIndex =
    coverIndex >= 0
      ? coverIndex
      : images.length && !images[0]?.placement
        ? 0
        : -1;
  const orderedImages =
    effectiveCoverIndex >= 0
      ? [
          images[effectiveCoverIndex]!,
          ...images.filter((_, index) => index !== effectiveCoverIndex),
        ]
      : images;
  const normalizedImages: ReviewedImage[] = orderedImages.map(
    (image, index) => ({
      ...image,
      placement:
        index === 0 && effectiveCoverIndex >= 0
          ? { anchor: "cover" }
          : image.placement && image.placement.anchor !== "cover"
            ? image.placement
            : {
                anchor: "after_section",
                sectionIndex: Math.min(
                  effectiveCoverIndex >= 0 ? index - 1 : index,
                  article.sections.length - 1,
                ),
              },
    }),
  );
  const imageUrls = normalizedImages.map((image) => image.url);
  const placedImages: PlacedArticleImage[] = normalizedImages
    .filter((image) => image.placement?.anchor !== "cover")
    .map((image) => ({
      url: image.url,
      title: image.title,
      placement: image.placement as PlacedArticleImage["placement"],
    }));
  let html: string;
  let note = artifact.note;
  if (target === "official_site") {
    html = renderWebsiteHtml(article, [], placedImages);
    validateOfficialHtml(html);
  } else if (target === "wechat") {
    html = renderWechatHtml(
      article,
      [],
      undefined,
      undefined,
      placedImages,
      input.request.wechatEnding,
    );
    validateWechatDraftFields({
      title: article.title,
      digest: article.description,
      contentHtml: html,
    });
    validateWechatDraftHtml(html);
  } else if (target === "xiaohongshu") {
    note = buildXiaohongshuNote(article, {
      primaryTag: input.request.primaryTag,
      secondaryTags: input.request.secondaryTags,
    });
    html = renderXiaohongshuHtml(note, imageUrls);
  } else {
    note = undefined;
    html = renderWebsiteHtml(article, [], placedImages);
  }

  const assets = normalizedImages.map((image) => ({
    selected: {
      id: image.id,
      title: image.title,
      url: image.url,
      primaryTags: [],
      secondaryTags: [],
      usageCount: 0,
    },
    selectedIdentity: image.id ?? image.url,
    usageCountBefore: 0,
    score: 100,
    selectionReason: "人工复核指定素材",
    manualReview: false,
    reason: "",
    rankedCandidates: [],
    placement: image.placement,
  }));
  const result = structuredClone(input.result);
  result.contentStatus = "ready";
  result.channelArticles = {
    ...(result.channelArticles ?? {}),
    [target]: article,
  };
  result.channelArtifacts[target] = {
    ...artifact,
    status: "ready",
    article,
    html,
    note,
    assets,
    reviewedCoverUrl: cover?.url,
    reviewedCover: cover,
    reviewedRevision: true,
    reviewedAt: new Date().toISOString(),
  };
  delete result.channelArtifacts[target].reason;
  if (target === "official_site") result.officialSiteHtml = html;
  if (target === "wechat") result.wechatHtml = html;
  if (target === "xiaohongshu") result.xiaohongshuHtml = html;
  if (target === "zhihu") result.zhihuHtml = html;
  if (target === "toutiao") result.toutiaoHtml = html;
  if (target === "baijiahao") result.baijiahaoHtml = html;
  if (target === "linkedin") result.linkedinHtml = html;
  result.assets = [
    ...(Array.isArray(result.assets) ? result.assets : []),
    ...assets,
  ];
  return result;
}
