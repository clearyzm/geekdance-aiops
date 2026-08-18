import type {
  Channel,
  CoreArticle,
  EvidenceItem,
  QaReport,
  ContentJobRequest,
} from "@geekdance/shared";
import { AI_WRITING_PATTERNS, BANNED_ABSOLUTE_CLAIMS } from "./rules.js";
import {
  validateWebsiteHtml,
  validateWechatHtml,
  validateXiaohongshuHtml,
} from "./layout.js";
import { editorialEndingErrors } from "./editorial-ending.js";

const UNSUPPORTED_NEGATIVE_MARKET_CLAIMS = [
  "没有市场空间",
  "毫无市场",
  "不值得开发",
  "没有开发价值",
  "没有必要开发",
  "注定失败",
];

function commercialDirectionErrors(
  article: CoreArticle,
  request?: ContentJobRequest,
) {
  if (request?.contentType !== "general") return [];
  const errors: string[] = [];
  const content = JSON.stringify(article);
  const negativeClaim = UNSUPPORTED_NEGATIVE_MARKET_CLAIMS.find((claim) =>
    content.includes(claim),
  );
  if (negativeClaim)
    errors.push(
      `不得无证据否定市场或开发价值：${negativeClaim}；请改为 MVP 验证条件和分阶段开发建议`,
    );
  const openingHasBrand = article.opening.join(" ").includes("极客跳动");
  const bodyHasBrand = article.sections
    .flatMap((section) => section.paragraphs)
    .join(" ")
    .includes("极客跳动");
  if (!openingHasBrand || !bodyHasBrand)
    errors.push(
      "“极客跳动”不能只在文章末尾出现；请在开场观点和正文实施段落中自然补充品牌的产品与开发视角",
    );
  return errors;
}

export function runQa(
  article: CoreArticle,
  evidence: EvidenceItem[],
  websiteHtml: string,
  wechatHtml: string,
  revisionCount = 0,
): QaReport {
  const content = JSON.stringify(article);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (article.sections.length < 3 || article.sections.length > 5)
    errors.push("正文必须包含 3-5 个主要章节");
  if (article.title.length < 10 || article.title.length > 32)
    errors.push("标题长度不适合官网与公众号");
  if (article.description.length < 40 || article.description.length > 140)
    errors.push("摘要应在 40-140 字之间");
  if (!evidence.length) errors.push("缺少证据清单");
  for (const claim of BANNED_ABSOLUTE_CLAIMS)
    if (content.includes(claim)) errors.push(`存在无证据绝对化表述：${claim}`);
  const aiPatternHits = AI_WRITING_PATTERNS.filter((pattern) =>
    content.includes(pattern),
  );
  if (aiPatternHits.length)
    warnings.push(`仍有 ${aiPatternHits.length} 处常见 AI 套话`);
  if (/\b我(?:认为|发现|经历|参与)/.test(content))
    errors.push("品牌文章不得虚构第一人称经历");
  errors.push(...editorialEndingErrors(article));
  errors.push(...commercialDirectionErrors(article));

  const dimensions = {
    directness: Math.max(1, 10 - aiPatternHits.length),
    rhythm:
      article.opening.length >= 2 &&
      article.sections.every((section) => section.paragraphs.length >= 1)
        ? 9
        : 7,
    trust: evidence.length ? 9 : 4,
    naturalness: Math.max(1, 10 - Math.ceil(aiPatternHits.length / 2)),
    concision: content.length < 18_000 ? 9 : 7,
  };
  const score = Object.values(dimensions).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (Object.values(dimensions).some((value) => value < 8) || score < 42)
    errors.push("去 AI 味质量分未达到 42/50");
  const website = validateWebsiteHtml(websiteHtml);
  const wechat = validateWechatHtml(wechatHtml);
  errors.push(
    ...website.errors.map((error) => `官网排版：${error}`),
    ...wechat.errors.map((error) => `公众号排版：${error}`),
  );
  return {
    passed: errors.length === 0,
    revisionCount,
    score,
    dimensions,
    errors,
    warnings,
    websiteLayout: website.report,
    wechatLayout: wechat.report,
  };
}

export function runChannelQa(
  channel: Channel,
  article: CoreArticle,
  evidence: EvidenceItem[],
  html: string,
  revisionCount = 0,
  request?: ContentJobRequest,
): QaReport {
  const content = JSON.stringify(article);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (article.sections.length < 3 || article.sections.length > 5)
    errors.push("正文必须包含 3-5 个主要章节");
  const maximumTitleLength =
    channel === "xiaohongshu"
      ? Number.POSITIVE_INFINITY
      : channel === "linkedin"
        ? 120
      : channel === "toutiao" || channel === "baijiahao"
        ? 30
        : 32;
  if (article.title.length < 10 || article.title.length > maximumTitleLength)
    errors.push(
      channel === "xiaohongshu"
        ? "原始标题不得少于 10 字"
        : `标题长度必须在 10-${maximumTitleLength} 字之间`,
    );
  const descriptionLimit = channel === "wechat" ? 128 : 140;
  if (
    article.description.length < 40 ||
    article.description.length > descriptionLimit
  )
    errors.push(`摘要应在 40-${descriptionLimit} 字之间`);
  if (!evidence.length) errors.push("缺少证据清单");
  const evidenceIds = new Set(evidence.map((item) => item.id));
  if (!article.evidenceIds.length) errors.push("文章未关联任何证据 ID");
  const unknownEvidenceIds = article.evidenceIds.filter(
    (id) => !evidenceIds.has(id),
  );
  if (unknownEvidenceIds.length)
    errors.push(`文章引用了不存在的证据 ID：${unknownEvidenceIds.join(", ")}`);
  for (const claim of BANNED_ABSOLUTE_CLAIMS)
    if (content.includes(claim)) errors.push(`存在无证据绝对化表述：${claim}`);
  const aiPatternHits = AI_WRITING_PATTERNS.filter((pattern) =>
    content.includes(pattern),
  );
  if (aiPatternHits.length)
    warnings.push(`仍有 ${aiPatternHits.length} 处常见 AI 套话`);
  if (/\b我(?:认为|发现|经历|参与)/.test(content))
    errors.push("品牌文章不得虚构第一人称经历");
  errors.push(...editorialEndingErrors(article));
  errors.push(...commercialDirectionErrors(article, request));
  if (request?.contentType === "case") {
    if (request.caseStatus === "proposal") {
      const forbiddenProposalClaims = [
        /已经上线/,
        /已上线/,
        /正式上线/,
        /成功交付/,
        /投入运营/,
        /实现(?:了)?\d/,
        /提升(?:了)?\d/,
        /降低(?:了)?\d/,
      ];
      if (forbiddenProposalClaims.some((pattern) => pattern.test(content)))
        errors.push("方案型案例不得声称已经上线、交付、运营或取得量化成效");
    }
    if (request.caseStatus === "delivered") {
      const resultClaim =
        /(?:上线|交付|验收|投入运营|提升|降低|增长|节省).{0,8}(?:\d|%|完成|成功)/;
      const resultEvidence = evidence.some(
        (item) =>
          item.sourceType === "user_attachment" &&
          /验收|上线|交付|运营数据|统计数据|效果|结果/.test(
            `${item.title} ${item.claims.join(" ")}`,
          ),
      );
      if (resultClaim.test(content) && !resultEvidence)
        errors.push("已交付案例的结果表述缺少验收、上线或数据类附件证据");
    }
  }

  const dimensions = {
    directness: Math.max(1, 10 - aiPatternHits.length),
    rhythm:
      article.opening.length >= 2 &&
      article.sections.every((section) => section.paragraphs.length >= 1)
        ? 9
        : 7,
    trust: evidence.length ? 9 : 4,
    naturalness: Math.max(1, 10 - Math.ceil(aiPatternHits.length / 2)),
    concision: content.length < 18_000 ? 9 : 7,
  };
  const score = Object.values(dimensions).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (Object.values(dimensions).some((value) => value < 8) || score < 42)
    errors.push("去 AI 味质量分未达到 42/50");

  const layout =
    channel === "official_site"
      ? validateWebsiteHtml(html)
      : channel === "wechat"
        ? validateWechatHtml(html)
        : channel === "xiaohongshu"
          ? validateXiaohongshuHtml(html)
          : validateWebsiteHtml(html);
  errors.push(
    ...layout.errors.map(
      (error) =>
        `${channel === "official_site" ? "官网" : channel === "wechat" ? "公众号" : channel === "xiaohongshu" ? "小红书" : channel === "zhihu" ? "知乎文章" : channel === "toutiao" ? "今日头条" : channel === "baijiahao" ? "百家号" : "LinkedIn"}排版：${error}`,
    ),
  );
  return {
    passed: errors.length === 0,
    revisionCount,
    score,
    dimensions,
    errors,
    warnings,
    ...(channel === "official_site"
      ? { websiteLayout: layout.report }
      : channel === "wechat"
        ? { wechatLayout: layout.report }
        : channel === "xiaohongshu"
          ? { xiaohongshuLayout: layout.report }
          : { websiteLayout: layout.report }),
  };
}
