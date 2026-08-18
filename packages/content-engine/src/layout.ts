import type {
  ArticleImagePlacement,
  ContentJobRequest,
  CoreArticle,
  XiaohongshuNote,
  WechatEnding,
} from "@geekdance/shared";

export const DEFAULT_WECHAT_ENDING: WechatEnding = {
  about:
    "极客跳动，技术团队上百人，10年开发经验。在高端软件开发项目上经验丰富，核心团队来自阿里、腾讯、携程等，秉持工程师文化与产品基因，以结果为导向，助力企业走向成功。",
  slogan: "做全球最靠谱的技术服务团队",
  phone: "182-9280-8250",
  website: "www.geekdance.cn",
  address: "深圳市宝安区易尚创意科技大厦19楼 极客跳动",
  services: ["高端软件定制｜AI相关产品开发", "智能硬件集成｜企业数字化转型"],
  recommendations: [],
};
import {
  isCompleteEditorialSentence,
  toIndependentEditorialSentence,
} from "./editorial-ending.js";

const escapeHtml = (value: string) =>
  value.replace(
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
const p = (value: string, mobile = false) =>
  `<p style="margin:0 0 ${mobile ? "18px" : "24px"};padding:0;color:#333333;font-size:${mobile ? "16px" : "inherit"};line-height:${mobile ? "1.875" : "1.9"};letter-spacing:0;text-align:left;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(value)}</p>`;

const withoutEndingPunctuation = (value: string) =>
  value.trim().replace(/[。！？!?；;，,、：:]+$/u, "");

export type PlacedArticleImage = {
  url: string;
  title?: string;
  placement: Exclude<ArticleImagePlacement, { anchor: "cover" }>;
};

function placementKey(
  placement: Exclude<ArticleImagePlacement, { anchor: "cover" }>,
) {
  if (placement.anchor === "after_opening")
    return `${placement.anchor}:${placement.paragraphIndex}`;
  if ("sectionIndex" in placement) {
    if (placement.anchor === "after_section_paragraph")
      return `${placement.anchor}:${placement.sectionIndex}:${placement.paragraphIndex}`;
    return `${placement.anchor}:${placement.sectionIndex}`;
  }
  return placement.anchor;
}

function placedImagesAt(
  images: PlacedArticleImage[] | undefined,
  placement: Exclude<ArticleImagePlacement, { anchor: "cover" }>,
) {
  if (!images?.length) return "";
  return images
    .filter(
      (image) => placementKey(image.placement) === placementKey(placement),
    )
    .map(
      (image) =>
        `<section data-gd-image-anchor="${escapeHtml(placement.anchor)}" style="margin:22px 0 28px;padding:0;"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || "文章配图")}" style="display:block;width:100%;height:auto;margin:0 auto;border:0;" /></section>`,
    )
    .join("");
}

function conciseClause(value: string, maxLength: number) {
  const normalized = toIndependentEditorialSentence(value);
  if (!normalized) return "";
  const firstSentence = normalized.match(/^.*?[。！？!?]/u)?.[0] ?? normalized;
  if (Array.from(firstSentence).length <= maxLength) return firstSentence;
  const clauses = firstSentence.split(/(?<=[，,；;：:])/u);
  let result = "";
  for (const clause of clauses) {
    if (Array.from(result + clause).length > maxLength) break;
    result += clause;
  }
  const fallback =
    result || Array.from(firstSentence).slice(0, maxLength).join("");
  return `${fallback.replace(/[，,；;：:。！？!?]+$/u, "")}。`;
}

export function conciseEditorialConclusion(article: CoreArticle) {
  return {
    conclusion: conciseClause(article.conclusion, 62),
    action: isCompleteEditorialSentence(article.cta)
      ? conciseClause(article.cta, 42)
      : "",
  };
}

export function editorialSummaryPoints(article: CoreArticle) {
  if (article.summaryPoints?.length === 3)
    return article.summaryPoints.map((point) => point.trim());
  return article.sections.slice(0, 3).map((section) => {
    const heading = displaySectionHeading(section.heading) || section.heading;
    const detail = section.bullets[0] || section.paragraphs[0] || "";
    const rawDetail = conciseClause(detail, 34);
    const conciseDetail = rawDetail
      ? /[。！？!?]$/u.test(rawDetail)
        ? rawDetail
        : `${rawDetail}。`
      : "";
    return conciseDetail && !conciseDetail.includes(heading)
      ? `${heading}：${conciseDetail}`
      : conciseClause(heading, 34);
  });
}

export function displaySectionHeading(value: string) {
  return value
    .replace(
      /^\s*(?:(?:第\s*)?[一二三四五六七八九十百]+\s*[、.．:：)）-]\s*|\d{1,2}\s*[、.．:：)）\]-]\s*|\d{1,2}\s+)/u,
      "",
    )
    .trim();
}

function sectionHtml(
  article: CoreArticle,
  mobile: boolean,
  imageUrls: string[],
  placedImages?: PlacedArticleImage[],
) {
  return article.sections
    .map((section, index) => {
      const number = String(index + 1).padStart(2, "0");
      const heading = displaySectionHeading(section.heading) || section.heading;
      const title = mobile
        ? `<p style="margin:0 0 18px;line-height:1.5;"><span style="display:inline-block;margin-right:10px;padding:4px 9px;background:#E52521;color:#FFFFFF;font-size:13px;font-weight:700;vertical-align:middle;">${number}</span><strong style="color:#171717;font-size:21px;font-weight:800;vertical-align:middle;">${escapeHtml(heading)}</strong></p>`
        : `<h2 style="margin:0 0 30px;color:#171717;font-size:28px;line-height:1.45;font-weight:800;"><span style="display:inline-block;box-sizing:border-box;width:62px;margin-right:18px;padding:8px 10px;background:#E52521;color:#FFFFFF;font-size:18px;font-weight:800;text-align:center;vertical-align:middle;">${number}</span><span style="color:#171717;vertical-align:middle;">${escapeHtml(heading)}</span></h2>`;
      const paragraphs = section.paragraphs
        .map(
          (value, paragraphIndex) =>
            `${p(value, mobile)}${placedImagesAt(placedImages, {
              anchor: "after_section_paragraph",
              sectionIndex: index,
              paragraphIndex,
            })}`,
        )
        .join("");
      const bullets = section.bullets.length
        ? mobile
          ? `<section data-gd-list="inline" style="margin:24px 0 30px;padding:0;">${section.bullets.map((item) => `<p data-gd-list-item="inline" style="margin:0 0 14px;padding:0;color:#333333;font-size:16px;line-height:1.8;"><span style="display:inline;color:#E52521;font-size:15px;font-weight:900;vertical-align:baseline;">■&nbsp;&nbsp;</span><span style="display:inline;color:#333333;vertical-align:baseline;">${escapeHtml(item)}</span></p>`).join("")}</section>`
          : `<ul style="margin:28px 0 32px;padding:0;list-style:none;">${section.bullets.map((item) => `<li style="margin:0 0 16px;color:#333333;line-height:1.8;"><span style="display:inline-block;margin-right:12px;color:#E52521;font-weight:900;">■</span>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "";
      const legacyImage =
        placedImages === undefined && imageUrls[index]
          ? `<img src="${escapeHtml(imageUrls[index]!)}" alt="${escapeHtml(heading)}配图" style="display:block;width:100%;height:auto;margin:22px auto;border:0;" />`
          : "";
      const beforeSection = placedImagesAt(placedImages, {
        anchor: "before_section",
        sectionIndex: index,
      });
      const afterHeading = placedImagesAt(placedImages, {
        anchor: "after_section_heading",
        sectionIndex: index,
      });
      const afterSection = placedImagesAt(placedImages, {
        anchor: "after_section",
        sectionIndex: index,
      });
      return `${beforeSection}<section data-gd-section="${number}" style="margin-top:${mobile ? "34px" : "64px"};">${title}${afterHeading}${paragraphs}${bullets}${legacyImage}${afterSection}</section>`;
    })
    .join("");
}

export function renderWebsiteHtml(
  article: CoreArticle,
  imageUrls: string[] = [],
  placedImages?: PlacedArticleImage[],
) {
  const ending = conciseEditorialConclusion(article);
  return `<div data-gd-root="website-article" style="box-sizing:border-box;max-width:820px;margin:0 auto;padding:28px 8px 40px;background:#FFFFFF;color:#333333;font-family:'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif;font-size:18px;line-height:1.9;">
<section data-gd-summary="website" style="margin:0 0 38px;padding:24px 26px 22px;border-top:4px solid #E52521;background:#F7F7F7;color:#333333;"><span style="display:block;margin:0 0 9px;color:#E52521;font-size:13px;font-weight:800;letter-spacing:0.12em;">摘要</span><p style="margin:0;color:#333333;font-size:16px;line-height:1.8;">${escapeHtml(article.description)}</p></section>${placedImagesAt(placedImages, { anchor: "after_summary" })}
${article.opening.map((value, paragraphIndex) => `${p(value)}${placedImagesAt(placedImages, { anchor: "after_opening", paragraphIndex })}`).join("\n")}
${sectionHtml(article, false, imageUrls, placedImages)}
${placedImagesAt(placedImages, { anchor: "before_observation" })}<div data-gd-callout="observation" style="position:relative;margin:42px 0;padding:28px 30px 26px;border:1px solid #E52521;background:#FFFFFF;color:#333333;line-height:1.85;"><span style="display:block;margin:-48px 0 10px;color:#E52521;background:#FFFFFF;font-size:48px;font-weight:900;line-height:1;width:48px;text-align:center;">“</span><p style="margin:0;color:#333333;line-height:1.85;"><strong style="color:#E52521;font-weight:800;">${escapeHtml(article.observationTitle?.trim() || "极客跳动观察")}：</strong>${escapeHtml(article.observation)}</p></div>
${placedImagesAt(placedImages, { anchor: "before_conclusion" })}
<section data-gd-conclusion="editorial" style="margin:70px 0 0;padding:34px 34px 30px;border-top:4px solid #E52521;background:#F7F7F7;color:#171717;line-height:1.85;"><span style="display:inline-block;margin:0 0 12px;padding:2px 9px;background:#E52521;color:#FFFFFF;font-size:12px;font-weight:800;letter-spacing:0.12em;line-height:1.7;">总结</span><p style="margin:0;color:#171717;font-size:18px;font-weight:700;line-height:1.8;">${escapeHtml(ending.conclusion)}</p>${ending.action ? `<p style="margin:14px 0 0;padding-left:14px;border-left:2px solid #E52521;color:#6B6B6B;font-size:16px;font-weight:400;line-height:1.8;">${escapeHtml(ending.action)}</p>` : ""}</section>
</div>`;
}

export function renderWechatHtml(
  article: CoreArticle,
  imageUrls: string[] = [],
  brandLogoUrl = "/brand/geekdance-logo.png",
  contactQrUrl = "/brand/geekdance-contact-qr.png",
  placedImages?: PlacedArticleImage[],
  endingConfig: WechatEnding = DEFAULT_WECHAT_ENDING,
) {
  const ending = conciseEditorialConclusion(article);
  const summaryPoints = editorialSummaryPoints(article);
  const cleanEnding = {
    about: withoutEndingPunctuation(endingConfig.about),
    slogan: withoutEndingPunctuation(endingConfig.slogan),
    phone: withoutEndingPunctuation(endingConfig.phone),
    website: withoutEndingPunctuation(endingConfig.website),
    address: withoutEndingPunctuation(endingConfig.address),
    services: endingConfig.services.map(withoutEndingPunctuation),
  };
  const endingSectionTitle = (title: string) =>
    `<p style="margin:0 0 18px;padding:0;color:#E52521;font-size:18px;font-weight:800;line-height:1.7;letter-spacing:.08em;text-align:center;">「${title}」</p>`;
  return `<section data-gd-root="article" style="box-sizing:border-box;margin:0 auto;padding:8px 2px 0;background:#FFFFFF;color:#333333;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:16px;line-height:1.875;letter-spacing:0;word-break:break-word;overflow-wrap:anywhere;">
<p style="margin:0 0 10px;color:#E52521;font-size:11px;font-weight:700;letter-spacing:0.12em;">GEEKDANCE · 企业 AI 落地观察</p>
<section data-gd-summary="wechat" style="position:relative;margin:18px 0 30px;padding:19px 18px 17px;border-top:4px solid #E52521;background:#F7F7F7;color:#333333;box-shadow:0 6px 18px rgba(23,23,23,0.05);"><span style="display:inline-block;margin:0 0 9px;padding:2px 8px;background:#E52521;color:#FFFFFF;font-size:11px;font-weight:800;letter-spacing:0.12em;line-height:1.6;">摘要</span><p style="margin:0;color:#333333;font-size:14px;line-height:1.8;">${escapeHtml(article.description)}</p></section>${placedImagesAt(placedImages, { anchor: "after_summary" })}
${article.opening.map((value, paragraphIndex) => `${p(value, true)}${placedImagesAt(placedImages, { anchor: "after_opening", paragraphIndex })}`).join("\n")}
${sectionHtml(article, true, imageUrls, placedImages)}
${placedImagesAt(placedImages, { anchor: "before_observation" })}<blockquote data-gd-callout="observation" style="margin:28px 0;padding:18px;background:#FFFFFF;border:1px solid #E52521;color:#333333;font-size:16px;line-height:1.875;letter-spacing:0;word-break:break-word;overflow-wrap:anywhere;"><strong style="color:#E52521;font-weight:800;">${escapeHtml(article.observationTitle?.trim() || "极客跳动观察")}：</strong><span style="color:#333333;">${escapeHtml(article.observation)}</span></blockquote>
${placedImagesAt(placedImages, { anchor: "before_conclusion" })}
<section data-gd-conclusion="editorial" style="margin:38px 0 42px;padding:22px 20px 20px;background:#FFFFFF;border:1px solid #E8E8E8;border-top:4px solid #E52521;color:#171717;box-shadow:0 8px 24px rgba(23,23,23,0.05);"><span style="display:inline-block;margin:0 0 12px;padding:2px 9px;background:#E52521;color:#FFFFFF;font-size:11px;font-weight:800;letter-spacing:0.12em;line-height:1.7;">总结</span><p style="margin:0 0 16px;color:#171717;font-size:16px;font-weight:700;line-height:1.75;letter-spacing:0;">${escapeHtml(ending.conclusion)}</p><div data-gd-summary-points="3" style="margin:0;padding:0;">${summaryPoints.map((point, index) => `<p style="position:relative;margin:${index ? "10px" : "0"} 0 0;padding:0 0 0 38px;color:#4B4B4F;font-size:14px;line-height:1.75;letter-spacing:0;text-align:left;word-break:break-word;overflow-wrap:anywhere;"><span style="position:absolute;left:0;top:0;display:block;width:30px;color:#E52521;font-weight:800;line-height:1.75;text-align:left;">${String(index + 1).padStart(2, "0")}</span>${escapeHtml(point)}</p>`).join("")}</div></section>
<section data-gd-promo-version="text-v3" style="box-sizing:border-box;margin:0;padding:0 22px 38px;background:#FFFFFF;color:#333333;text-align:center;font-size:13px;line-height:1.85;letter-spacing:0;border-radius:18px;">
  <div data-gd-ending-divider="top" style="height:1px;margin:0 0 46px;background:#E4E4E7;line-height:1;"></div>
  <span data-gd-brand-lockup="connected" style="display:block;width:146px;margin:0 auto 34px;overflow:hidden;text-align:center;line-height:1;">
    <img src="${escapeHtml(brandLogoUrl)}" alt="极客跳动" style="display:block;width:146px;height:30px;margin:0 auto 4px;border:0;object-fit:cover;object-position:top;" />
    <span style="display:block;margin:0;color:#171717;font-family:Arial,'Helvetica Neue',sans-serif;font-size:12px;font-weight:800;letter-spacing:-0.03em;line-height:1;white-space:nowrap;">GeekDance</span>
  </span>
  <div data-gd-ending-section="about" style="margin:0 0 38px;">${endingSectionTitle("关于我们")}
  <p style="margin:0 0 10px;font-weight:700;line-height:1.85;">极客跳动 GeekDance</p>
  <p style="margin:0 0 18px;font-size:15px;font-weight:800;line-height:1.85;">${escapeHtml(cleanEnding.slogan)}</p>
  <p style="margin:0 auto;max-width:278px;color:#666666;line-height:1.85;text-align:center;word-break:normal;overflow-wrap:break-word;">${escapeHtml(cleanEnding.about)}</p></div>
  <div data-gd-ending-section="contact" style="margin:0 0 38px;">${endingSectionTitle("联系方式")}
  <img src="${escapeHtml(contactQrUrl)}" alt="极客跳动微信二维码" style="display:block;width:148px;height:148px;object-fit:contain;margin:0 auto 14px;border:0;" />
  <p style="margin:0;color:#555555;line-height:1.85;">电话：${escapeHtml(cleanEnding.phone)}<br/>官网：${escapeHtml(cleanEnding.website)}<br/>地址：${escapeHtml(cleanEnding.address)}</p></div>
  <div data-gd-ending-section="services" style="margin:0 0 38px;">${endingSectionTitle("主营业务")}<p style="margin:0;color:#333333;line-height:1.85;">${cleanEnding.services.map(escapeHtml).join("<br/>")}</p></div>
  <div data-gd-recommendations="wechat" style="margin:0;text-align:left;"><p style="margin:0 0 22px;padding:0;color:#666A73;font-size:14px;line-height:1;text-align:center;white-space:nowrap;"><span style="display:inline-block;width:30%;border-top:1px solid #8C8C91;vertical-align:middle;line-height:1;">&nbsp;</span><span style="display:inline-block;width:104px;text-align:center;vertical-align:middle;">精彩推荐</span><span style="display:inline-block;width:30%;border-top:1px solid #8C8C91;vertical-align:middle;line-height:1;">&nbsp;</span></p>${endingConfig.recommendations.length ? endingConfig.recommendations.map((item, index) => `<p style="margin:${index ? "12px" : "0"} 0 0;padding:0;line-height:1.75;"><a href="${escapeHtml(item.url)}" style="color:#333333;text-decoration:none;font-size:14px;letter-spacing:0;word-break:break-word;overflow-wrap:anywhere;">${String(index + 1).padStart(2, "0")}　${escapeHtml(withoutEndingPunctuation(item.title))}</a></p>`).join("") : `<p style="margin:0;color:#9A9AA1;font-size:13px;line-height:1.75;text-align:center;">可在公众号结尾管理中添加往期文章</p>`}</div>
</section>
</section>`;
}

function normalizeHashtag(value: string) {
  return value
    .replace(/^#+/, "")
    .replace(/[\s#]+/g, "")
    .slice(0, 20);
}

const XIAOHONGSHU_BRAND_HASHTAGS = [
  "极客跳动",
  "GeekDance",
  "技术团队",
  "企业数字化转型",
  "软件定制开发",
  "深圳APP开发公司哪家好",
  "深圳软件开发公司",
  "极客跳动靠谱",
] as const;

export function buildXiaohongshuNote(
  article: CoreArticle,
  request: Pick<ContentJobRequest, "primaryTag" | "secondaryTags">,
): XiaohongshuNote {
  const clean = (value?: string) =>
    value
      ?.replace(/^【|】$/g, "")
      // The model may already prefix headings with `01 `, `01｜`, `1.` or
      // Chinese numerals. The Xiaohongshu renderer adds its own deterministic
      // section number, so strip any existing prefix to avoid `01｜01 ...`.
      .replace(
        /^\s*(?:0?[1-9]|[一二三四五六七八九十]+)(?:\s*[、｜|.．:：]\s*|\s+)/,
        "",
      )
      .trim() ?? "";
  const opening = article.opening
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(0, 2);
  const hashtags = [
    request.primaryTag,
    ...(request.secondaryTags ?? []),
    "企业AI",
    ...XIAOHONGSHU_BRAND_HASHTAGS,
  ]
    .flatMap((value) => (value ? [normalizeHashtag(value)] : []))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    // Keep a few article-specific topics first, then always preserve the
    // complete GeekDance brand/business topic set requested by operations.
    .filter(
      (value, index, values) =>
        index < 4 ||
        XIAOHONGSHU_BRAND_HASHTAGS.includes(
          value as (typeof XIAOHONGSHU_BRAND_HASHTAGS)[number],
        ) ||
        values.length <= 12,
    )
    .slice(0, 12);
  const hashtagLine = hashtags.map((tag) => `#${tag}`).join(" ");
  const bodyLimit = Math.max(50, 780 - hashtagLine.length - 2);
  const completeExcerpt = (value: string, limit: number) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [];
    let excerpt = "";
    for (const sentence of sentences) {
      const candidate = `${excerpt}${sentence}`;
      if (candidate.length > limit) break;
      excerpt = candidate;
    }
    if (excerpt.trim()) return excerpt.trim();
    const punctuation = [...normalized.matchAll(/[，、：:]/gu)]
      .map((match) => match.index ?? -1)
      .filter((index) => index >= Math.floor(limit * 0.55) && index < limit)
      .at(-1);
    return punctuation === undefined
      ? `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
      : `${normalized.slice(0, punctuation).trimEnd()}。`;
  };
  const sectionCount = Math.max(1, article.sections.slice(0, 4).length);
  const sectionBudget = Math.max(
    42,
    Math.floor((bodyLimit - 250) / sectionCount),
  );
  const compactSections = article.sections.slice(0, 4).map((section, index) => {
    const heading = `${String(index + 1).padStart(2, "0")}｜${clean(section.heading)}`;
    const paragraph = completeExcerpt(
      section.paragraphs.filter(Boolean).join(" "),
      Math.max(28, sectionBudget - heading.length - 4),
    );
    const firstBullet = section.bullets
      .map((bullet) => bullet.trim())
      .find(Boolean);
    return [
      heading,
      paragraph,
      firstBullet ? `· ${completeExcerpt(firstBullet, 34)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const requiredEnding = [
    "极客跳动观察",
    completeExcerpt(
      article.observation.trim() || article.conclusion.trim(),
      68,
    ),
    completeExcerpt(article.conclusion.trim(), 46),
    completeExcerpt(article.cta.trim(), 34),
  ].filter(Boolean);
  let bodyParts = [
    "GeekDance｜数字产品落地观察",
    completeExcerpt(opening.join(" "), 76),
    ...compactSections,
    ...requiredEnding,
  ].filter((value): value is string => Boolean(value?.trim()));
  // Keep every chapter heading and the editorial ending. If an unusually long
  // model response still exceeds the platform allowance, remove optional
  // bullet lines before shortening any complete sentence.
  let body = bodyParts.join("\n\n");
  if (body.length > bodyLimit) {
    bodyParts = bodyParts.map((part) =>
      /^\d{2}｜/u.test(part)
        ? part
            .split("\n")
            .filter((line) => !line.startsWith("· "))
            .join("\n")
        : part,
    );
    body = bodyParts.join("\n\n");
  }
  if (body.length > bodyLimit) {
    const endingBlock = requiredEnding.join("\n\n");
    const prefixLimit = Math.max(50, bodyLimit - endingBlock.length - 2);
    const prefix = completeExcerpt(
      bodyParts.slice(0, -requiredEnding.length).join("\n\n"),
      prefixLimit,
    );
    body = [prefix, endingBlock].filter(Boolean).join("\n\n");
  }
  return {
    title: article.title.trim().slice(0, 20),
    body: body.trimEnd(),
    hashtags,
  };
}

export function renderXiaohongshuHtml(
  note: XiaohongshuNote,
  imageUrls: string[] = [],
) {
  const images = imageUrls
    .map(
      (url, index) =>
        `<img src="${escapeHtml(url)}" alt="小红书配图 ${index + 1}" style="display:block;width:100%;height:auto;margin:0 0 12px;border-radius:12px;" />`,
    )
    .join("");
  return `<article data-gd-root="xiaohongshu-note" style="box-sizing:border-box;max-width:390px;margin:0 auto;padding:14px;background:#FFFFFF;color:#171717;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;">
<div data-gd-gallery="xiaohongshu" style="margin:0 0 18px;">${images}</div>
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.4;font-weight:800;">${escapeHtml(note.title)}</h1>
${note.body
  .split(/\n{2,}/)
  .map(
    (paragraph) =>
      `<p style="margin:0 0 12px;font-size:15px;line-height:1.75;white-space:pre-wrap;">${escapeHtml(paragraph)}</p>`,
  )
  .join("")}
<p data-gd-hashtags="xiaohongshu" style="margin:18px 0 0;color:#315E9B;font-size:14px;line-height:1.8;">${note.hashtags.map((tag) => `#${escapeHtml(tag)}`).join(" ")}</p>
</article>`;
}

function count(html: string, pattern: RegExp) {
  return html.match(pattern)?.length ?? 0;
}
export function validateWebsiteHtml(html: string) {
  const report = {
    inlineStyles: count(html, /\sstyle=["'][^"']+["']/gi),
    redTokens: count(html, /#e52521/gi),
    sections: count(html, /data-gd-section=["']/gi),
    callouts: count(html, /data-gd-callout=["']/gi),
    conclusions: count(html, /data-gd-conclusion=["']/gi),
    root: /data-gd-root=["']website-article["']/i.test(html),
    styleTags: count(html, /<style\b/gi),
    headings: count(html, /<h2\b/gi),
    promotionMarkers: count(
      html,
      /geekdance-promo-board|gd-promo|关于我们|联系方式|主营业务/gi,
    ),
  };
  const errors = [
    report.inlineStyles < 12 && "inlineStyles < 12",
    report.redTokens < 4 && "redTokens < 4",
    report.sections < 3 && "sections < 3",
    report.callouts < 1 && "missing callout",
    report.conclusions < 1 && "missing conclusion",
    !report.root && "missing root",
    report.styleTags > 0 && "style tags forbidden",
    report.headings < 3 && "h2 headings < 3",
    report.promotionMarkers > 0 && "promotion content forbidden",
  ].filter(Boolean) as string[];
  return { ok: errors.length === 0, report, errors };
}

export function validateWechatHtml(html: string) {
  const report = {
    inlineStyles: count(html, /\sstyle=["'][^"']+["']/gi),
    redTokens: count(html, /#e52521/gi),
    sections: count(html, /data-gd-section=["']/gi),
    callouts: count(html, /data-gd-callout=["']/gi),
    conclusions: count(html, /data-gd-conclusion=["']/gi),
    promotionBoards: count(html, /data-gd-promo-version=["']text-v3["']/gi),
    images: count(html, /<img\b/gi),
    root: /data-gd-root=["']article["']/i.test(html),
  };
  const errors = [
    report.inlineStyles < 10 && "inlineStyles < 10",
    report.redTokens < 4 && "redTokens < 4",
    report.sections < 3 && "sections < 3",
    report.callouts < 1 && "missing callout",
    report.conclusions < 1 && "missing conclusion",
    report.promotionBoards !== 1 && "promotion board must appear once",
    report.images < 2 && "images < 2",
    !report.root && "missing root",
  ].filter(Boolean) as string[];
  return { ok: errors.length === 0, report, errors };
}

export function validateXiaohongshuHtml(html: string) {
  const report = {
    root: /data-gd-root=["']xiaohongshu-note["']/i.test(html),
    galleries: count(html, /data-gd-gallery=["']xiaohongshu["']/gi),
    hashtags: count(html, /data-gd-hashtags=["']xiaohongshu["']/gi),
    images: count(html, /<img\b/gi),
    headings: count(html, /<h1\b/gi),
    forbiddenPublishCopy: count(html, /立即发布|确认发布|正式发布|发布笔记/gi),
  };
  const errors = [
    !report.root && "missing root",
    report.galleries !== 1 && "gallery must appear once",
    report.hashtags !== 1 && "hashtags must appear once",
    report.images < 3 && "images < 3",
    report.headings !== 1 && "title must appear once",
    report.forbiddenPublishCopy > 0 && "publish action copy forbidden",
  ].filter(Boolean) as string[];
  return { ok: errors.length === 0, report, errors };
}
