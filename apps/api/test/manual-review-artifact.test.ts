import { describe, expect, it } from "vitest";
import type { CoreArticle } from "@geekdance/shared";
import { applyManualReviewRevision } from "../src/manual-review-artifact.js";

const article: CoreArticle = {
  title: "人工复核后的文章标题",
  description: "运营人员已核对内容并补充与章节相关的项目图片。",
  opening: ["这是开篇第一段。", "这是开篇第二段。"],
  sections: [1, 2, 3].map((index) => ({
    heading: `章节 ${index}`,
    paragraphs: [`章节 ${index} 的正文内容。`],
    bullets: [`章节 ${index} 的要点`],
  })),
  observation: "人工复核需要同时覆盖内容和图片。",
  conclusion: "通过结构化修改，渠道草稿可以使用最终复核版本。",
  cta: "提交前再次检查标题、摘要和配图。",
  evidenceIds: [],
};

const images = [1, 2, 3].map((index) => ({
  id: `image-${index}`,
  title: `配图 ${index}`,
  url: `https://aiops.geekdance.cn/api/public/assets/image-${index}/signature`,
}));

function resultFor(
  target:
    | "official_site"
    | "wechat"
    | "xiaohongshu"
    | "zhihu"
    | "toutiao"
    | "baijiahao"
    | "linkedin",
) {
  return {
    contentStatus: "blocked",
    article,
    assets: [],
    channelArtifacts: {
      [target]: {
        status: "manual_review",
        template: { skillName: "test", version: "1", sourceHash: "hash" },
        article,
        assets: [{ selected: null }, { selected: null }, { selected: null }],
        reason: "没有达到相关性阈值的 GeekHome 素材",
      },
    },
  };
}

describe("manual review artifact revision", () => {
  it("rebuilds a valid official-site artifact with reviewed images", () => {
    const result = applyManualReviewRevision({
      result: resultFor("official_site"),
      target: "official_site",
      article,
      images,
      request: {},
    });
    expect(result.contentStatus).toBe("ready");
    expect(result.channelArtifacts.official_site.status).toBe("ready");
    expect(result.channelArtifacts.official_site.reason).toBeUndefined();
    expect(result.officialSiteHtml).toContain(images[1]!.url);
    expect(result.channelArtifacts.official_site.assets).toHaveLength(3);
  });

  it("rebuilds a valid WeChat artifact from the reviewed article", () => {
    const result = applyManualReviewRevision({
      result: resultFor("wechat"),
      target: "wechat",
      article,
      images,
      request: {},
    });
    expect(result.wechatHtml).toContain('data-gd-root="article"');
    expect(result.wechatHtml).toContain(images[2]!.url);
    expect(result.channelArticles.wechat.title).toBe(article.title);
  });

  it("preserves reviewed WeChat summary points in the final artifact", () => {
    const reviewedArticle: CoreArticle = {
      ...article,
      summaryPoints: ["修改后的要点一", "修改后的要点二", "修改后的要点三"],
    };
    const result = applyManualReviewRevision({
      result: resultFor("wechat"),
      target: "wechat",
      article: reviewedArticle,
      images: [],
      request: {},
    });

    expect(result.wechatHtml).toContain("01</span>修改后的要点一");
    expect(result.wechatHtml).toContain("02</span>修改后的要点二");
    expect(result.wechatHtml).toContain("03</span>修改后的要点三");
    expect(result.channelArticles.wechat.summaryPoints).toEqual(
      reviewedArticle.summaryPoints,
    );
  });

  it("allows approval without reviewed images", () => {
    const result = applyManualReviewRevision({
      result: resultFor("official_site"),
      target: "official_site",
      article,
      images: [],
      request: {},
    });

    expect(result.contentStatus).toBe("ready");
    expect(result.channelArtifacts.official_site.assets).toEqual([]);
  });

  it.each([
    ["zhihu", "zhihuHtml"],
    ["toutiao", "toutiaoHtml"],
    ["baijiahao", "baijiahaoHtml"],
    ["linkedin", "linkedinHtml"],
  ] as const)("rebuilds the reviewed %s article", (channel, htmlField) => {
    const result = applyManualReviewRevision({
      result: resultFor(channel),
      target: channel,
      article,
      images,
      request: {},
    });
    expect(result.channelArtifacts[channel].status).toBe("ready");
    expect(result[htmlField]).toContain('data-gd-root="website-article"');
    expect(result[htmlField]).toContain(images[1]!.url);
  });

  it("stores a channel-specific cover separately from body images", () => {
    const cover = {
      id: "geekhome-cover",
      title: "GeekHome 真实项目封面",
      url: "https://home.geekdance.app/material/cover.jpg",
      metadata: {
        wechatCoverStyleVersion: "geekdance-real-photo-stacked-dual-crop-v16",
      },
    };
    const bodyImage = {
      ...images[0]!,
      placement: { anchor: "after_summary" as const },
    };
    const result = applyManualReviewRevision({
      result: resultFor("wechat"),
      target: "wechat",
      article,
      images: [bodyImage],
      cover,
      request: {},
    });

    expect(result.channelArtifacts.wechat.reviewedCoverUrl).toBe(cover.url);
    expect(result.channelArtifacts.wechat.reviewedCover.metadata).toEqual(
      cover.metadata,
    );
    expect(result.wechatHtml).toContain(bodyImage.url);
    expect(result.channelArtifacts.wechat.assets[0].placement).toEqual(
      bodyImage.placement,
    );
  });

  it("allows a WeChat review to pass without editorial images", () => {
    const result = applyManualReviewRevision({
      result: resultFor("wechat"),
      target: "wechat",
      article,
      images: [],
      request: {},
    });

    expect(result.contentStatus).toBe("ready");
    expect(result.channelArtifacts.wechat.assets).toEqual([]);
    expect(result.wechatHtml).toContain('data-gd-promo-version="text-v3"');
  });

  it("renders reviewed images at the exact selected paragraph anchors", () => {
    const placedImages = [
      { ...images[0]!, placement: { anchor: "cover" as const } },
      {
        ...images[1]!,
        placement: { anchor: "after_opening" as const, paragraphIndex: 0 },
      },
      {
        ...images[2]!,
        placement: {
          anchor: "after_section_paragraph" as const,
          sectionIndex: 1,
          paragraphIndex: 0,
        },
      },
    ];
    const result = applyManualReviewRevision({
      result: resultFor("official_site"),
      target: "official_site",
      article,
      images: placedImages,
      request: {},
    });
    const html = result.officialSiteHtml as string;

    expect(html.indexOf("这是开篇第一段。")).toBeLessThan(
      html.indexOf(images[1]!.url),
    );
    expect(html.indexOf(images[1]!.url)).toBeLessThan(
      html.indexOf("这是开篇第二段。"),
    );
    expect(html.indexOf("章节 2 的正文内容。")).toBeLessThan(
      html.indexOf(images[2]!.url),
    );
    expect(html).toContain('data-gd-image-anchor="after_section_paragraph"');
    expect(result.channelArtifacts.official_site.assets[1].placement).toEqual(
      placedImages[1]!.placement,
    );
  });

  it("keeps exact image anchors in valid WeChat draft HTML", () => {
    const placedImages = [
      { ...images[0]!, placement: { anchor: "cover" as const } },
      {
        ...images[1]!,
        placement: {
          anchor: "after_section_heading" as const,
          sectionIndex: 0,
        },
      },
      {
        ...images[2]!,
        placement: { anchor: "before_conclusion" as const },
      },
    ];
    const result = applyManualReviewRevision({
      result: resultFor("wechat"),
      target: "wechat",
      article,
      images: placedImages,
      request: {},
    });
    const html = result.wechatHtml as string;

    expect(html.indexOf("章节 1</strong>")).toBeLessThan(
      html.indexOf(images[1]!.url),
    );
    expect(html.indexOf(images[1]!.url)).toBeLessThan(
      html.indexOf("章节 1 的正文内容。"),
    );
    expect(html.indexOf(images[2]!.url)).toBeLessThan(
      html.indexOf('data-gd-conclusion="editorial"'),
    );
    expect(html).toContain('data-gd-image-anchor="before_conclusion"');
  });
});
