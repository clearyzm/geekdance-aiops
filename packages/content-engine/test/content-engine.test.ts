import { afterEach, describe, expect, it, vi } from "vitest";
import {
  automationScheduleRequestSchema,
  browserDraftChannelSchema,
  channelSchema,
  contentRuntimeIssues,
  contentJobRequestSchema,
  imageRuntimeIssues,
  imageJobRequestSchema,
  xiaohongshuNoteSchema,
  type WorkerRuntimeSnapshot,
} from "@geekdance/shared";
import {
  classifyContentScope,
  conciseEditorialConclusion,
  createLivePorts,
  displaySectionHeading,
  editorialEndingErrors,
  getChannelTemplateRef,
  mockPorts,
  renderWechatHtml,
  renderWebsiteHtml,
  renderXiaohongshuHtml,
  buildXiaohongshuNote,
  runContentPipeline,
  searchGeekHomeMaterials,
  selectMaterial,
  validateWechatHtml,
  validateWebsiteHtml,
  validateXiaohongshuHtml,
  validateCaseDiagramSpecs,
} from "../src/index.js";

const request = contentJobRequestSchema.parse({
  operationId: "11111111-1111-4111-8111-111111111111",
  topic: "企业如何把 AI Agent 接入业务流程",
  readerMode: "general",
  sourceRefs: [],
  targets: ["official_site", "wechat"],
  imageMode: "geekhome",
  primaryTag: "AI",
  secondaryTags: ["智能体"],
});
const liveEvidence = [
  {
    id: "source-1",
    title: "OpenRouter documentation",
    url: "https://openrouter.ai/docs",
    sourceType: "authoritative" as const,
    claims: ["OpenRouter provides a compatible API"],
    accessedAt: new Date().toISOString(),
  },
];
const validLiveArticle = {
  title: "企业 AI 内容生产进入稳定运营阶段",
  description: "从试用走向稳定运营，需要把模型、流程和质量控制连接起来。",
  opening: [
    "企业开始关注 AI 的实际产出。",
    "极客跳动更关注模型如何进入可稳定验收的完整流程。",
  ],
  sections: [
    {
      heading: "从明确目标开始",
      paragraphs: ["先确定业务目标和读者需求。"],
      bullets: [],
    },
    {
      heading: "建立可追溯流程",
      paragraphs: ["内容中的事实需要能够回到原始证据。"],
      bullets: ["保留证据清单"],
    },
    {
      heading: "持续检查质量",
      paragraphs: [
        "发布前应检查内容与渠道格式，极客跳动可根据企业审核和发布流程定制系统。",
      ],
      bullets: [],
    },
  ],
  observation: "流程稳定性比单次生成速度更重要。",
  conclusion: "把各环节连接起来，AI 内容生产才能稳定运行。",
  cta: "极客跳动可协助企业建设适合自身业务的 AI 应用。",
  evidenceIds: ["source-1"],
};
const liveRuntime: WorkerRuntimeSnapshot = {
  release: "test",
  recordedAt: new Date().toISOString(),
  contentEngineMode: "openrouter",
  imageProviderMode: "openrouter",
  officialPublisherMode: "live",
  officialAllowProduction: true,
  wechatPublisherMode: "live",
  wechatAllowProduction: true,
  textModel: "openai/gpt-5.6-sol",
  imageModel: "openai/gpt-5.4-image-2",
  textKeyConfigured: true,
  imageKeyConfigured: true,
  geekHomeConfigured: true,
  assetPublicSecretConfigured: true,
};

describe("content engine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("routes case requests to manual review", () => {
    expect(classifyContentScope("某客户案例类文章").scope).toBe("case");
    expect(classifyContentScope("企业 AI Agent 趋势").scope).toBe("general");
    expect(
      classifyContentScope("解释技术选型取舍，不虚构客户案例或量化结果").scope,
    ).toBe("general");
    expect(
      classifyContentScope(
        "企业 AI 内容生产工作流",
        "",
        "不得虚构客户、数据或实施结果",
      ).scope,
    ).toBe("general");
  });

  it("validates the content request schema", () => {
    expect(() =>
      contentJobRequestSchema.parse({ ...request, targets: [] }),
    ).toThrow();
    expect(() =>
      contentJobRequestSchema.parse({
        ...request,
        contentType: "case",
        caseStatus: "proposal",
        targets: ["xiaohongshu"],
        imageMode: "generated",
        caseVisualTypes: ["cover", "function"],
      }),
    ).toThrow("案例模式必须上传");
    expect(
      contentJobRequestSchema.parse({
        ...request,
        contentType: "case",
        caseStatus: "proposal",
        targets: ["xiaohongshu"],
        imageMode: "generated",
        attachmentIds: ["44444444-4444-4444-8444-444444444444"],
        caseVisualTypes: ["cover", "function", "architecture"],
      }).caseVisualTypes,
    ).toEqual(["cover", "function", "architecture"]);
    expect(contentJobRequestSchema.parse(request).topic).toContain("Agent");
    expect(
      contentJobRequestSchema.parse({
        ...request,
        attachmentIds: ["44444444-4444-4444-8444-444444444444"],
      }).attachmentIds,
    ).toHaveLength(1);
    expect(() =>
      contentJobRequestSchema.parse({
        ...request,
        attachmentIds: Array.from({ length: 11 }, () => crypto.randomUUID()),
      }),
    ).toThrow();
    expect(() =>
      contentJobRequestSchema.parse({
        ...request,
        targets: ["official_site", "official_site"],
      }),
    ).toThrow();
  });

  it("blocks production jobs when the actual worker is offline or in Mock mode", () => {
    expect(contentRuntimeIssues(null, request)[0]?.code).toBe("WORKER_OFFLINE");
    expect(
      contentRuntimeIssues(
        {
          ...liveRuntime,
          contentEngineMode: "mock_geekhome",
          officialPublisherMode: "mock",
        },
        request,
      ).map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "CONTENT_ENGINE_NOT_LIVE",
        "OFFICIAL_PUBLISHER_NOT_LIVE",
      ]),
    );
    expect(contentRuntimeIssues(liveRuntime, request)).toEqual([]);
    expect(
      contentRuntimeIssues(
        { ...liveRuntime, contentEngineMode: "openai" },
        request,
      ),
    ).toEqual([]);
    expect(
      contentRuntimeIssues(
        {
          ...liveRuntime,
          contentEngineMode: "openai",
          textKeyConfigured: false,
        },
        request,
      )[0]?.code,
    ).toBe("TEXT_API_KEY_MISSING");
    expect(imageRuntimeIssues(liveRuntime, "compose")).toEqual([]);
  });

  it("does not require GeekHome when the request explicitly uses AI images", () => {
    expect(
      contentRuntimeIssues(
        {
          release: "test",
          recordedAt: new Date().toISOString(),
          contentEngineMode: "openrouter",
          imageProviderMode: "openrouter",
          officialPublisherMode: "live",
          officialAllowProduction: true,
          wechatPublisherMode: "live",
          wechatAllowProduction: true,
          textModel: "openai/gpt-5.6-sol",
          imageModel: "openai/gpt-5.4-image-2",
          textKeyConfigured: true,
          imageKeyConfigured: true,
          geekHomeConfigured: false,
          assetPublicSecretConfigured: true,
        },
        { targets: ["official_site"], imageMode: "generated" },
      ),
    ).toEqual([]);
  });

  it("reuses six inline images while requesting one independent Xiaohongshu cover", async () => {
    const generateImages = vi.fn(mockPorts.generateImages);
    const result = await runContentPipeline(
      contentJobRequestSchema.parse({
        ...request,
        targets: ["xiaohongshu", "wechat", "official_site"],
        imageMode: "generated",
      }),
      { ...mockPorts, generateImages },
    );

    expect(result.status).toBe("ready");
    expect(generateImages).toHaveBeenCalledTimes(1);
    expect(generateImages.mock.calls[0]?.[0].targets).toEqual([
      "xiaohongshu",
      "wechat",
      "official_site",
    ]);
    if (result.status !== "ready") return;
    expect(
      result.channelArtifacts.official_site?.assets.map(
        (asset) => asset.selected?.id,
      ),
    ).toEqual(
      result.channelArtifacts.wechat?.assets.map((asset) => asset.selected?.id),
    );
    expect(
      result.channelArtifacts.official_site?.assets.map(
        (asset) => asset.selected?.id,
      ),
    ).toEqual(
      result.channelArtifacts.xiaohongshu?.assets.map(
        (asset) => asset.selected?.id,
      ),
    );
  });

  it("reuses the same GeekHome selections across all three channels", async () => {
    const searchMaterials = vi.fn(mockPorts.searchMaterials);
    const result = await runContentPipeline(
      contentJobRequestSchema.parse({
        ...request,
        targets: ["xiaohongshu", "wechat", "official_site"],
      }),
      {
        ...mockPorts,
        searchMaterials,
      },
    );

    expect(result.status).toBe("ready");
    expect(searchMaterials).toHaveBeenCalledTimes(1);
    if (result.status !== "ready") return;
    expect(
      result.channelArtifacts.official_site?.assets.map(
        (asset) => asset.selected?.id,
      ),
    ).toEqual(
      result.channelArtifacts.wechat?.assets.map((asset) => asset.selected?.id),
    );
    expect(
      result.channelArtifacts.official_site?.assets.map(
        (asset) => asset.selected?.id,
      ),
    ).toEqual(
      result.channelArtifacts.xiaohongshu?.assets.map(
        (asset) => asset.selected?.id,
      ),
    );
  });

  it("always preserves a user-supplied article title", async () => {
    const manualTitle = "企业软件项目降低返工的验收方法";
    const result = await runContentPipeline(
      { ...request, title: manualTitle },
      {
        ...mockPorts,
        write: async (...args) => ({
          ...(await mockPorts.write(...args)),
          title: "模型自行生成的标题不应生效",
        }),
      },
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.channelArtifacts.official_site?.article?.title).toBe(
      manualTitle,
    );
    expect(result.channelArtifacts.wechat?.article?.title).toBe(manualTitle);
  });

  it("styles summaries and removes duplicate section numbering", () => {
    const numberedArticle = {
      ...validLiveArticle,
      sections: validLiveArticle.sections.map((section, index) => ({
        ...section,
        heading: `${String(index + 1).padStart(2, "0")} ${section.heading}`,
      })),
    };
    const html = renderWechatHtml(numberedArticle);

    expect(displaySectionHeading("01 先明确需求")).toBe("先明确需求");
    expect(displaySectionHeading("一、先明确需求")).toBe("先明确需求");
    expect(html).toContain('data-gd-summary="wechat"');
    expect(html).not.toContain(`<h1`);
    expect(html).toContain('data-gd-list-item="inline"');
    expect(html).toContain('<span style="display:inline;color:#E52521');
    expect(html).toContain(">总结</span>");
    expect(html).toContain('data-gd-summary-points="3"');
    expect(html).toContain("从明确目标开始：先确定业务目标和读者需求。");
    expect(html).toContain("建立可追溯流程：保留证据清单。");
    expect(html).toContain("持续检查质量：发布前应检查内容与渠道格式。");
    expect(html).not.toContain(validLiveArticle.cta);
    expect(html).toContain("做全球最靠谱的技术服务团队");
    expect(html).not.toContain("做深圳最靠谱的技术服务团队");
    expect(html).toContain("max-width:278px");
    expect(html).not.toContain("01 从明确目标开始");
    const concise = conciseEditorialConclusion({
      ...numberedArticle,
      conclusion:
        "这是一个需要同时检查正文、封面、标题和草稿状态的较长总结，后续还包含不应全部进入卡片的补充说明。第二句也不需要进入总结卡片。",
      cta: "下一步只需逐项核对草稿，再决定是否进入后续流程。额外说明不应重复出现。",
    });
    expect(Array.from(concise.conclusion).length).toBeLessThanOrEqual(63);
    expect(Array.from(concise.action).length).toBeLessThanOrEqual(43);
    expect(renderWebsiteHtml(numberedArticle)).toContain(
      'data-gd-summary="website"',
    );
    expect(renderWebsiteHtml(numberedArticle)).toContain(">总结</span>");
  });

  it("uses the three summary points edited during WeChat review", () => {
    const html = renderWechatHtml({
      ...validLiveArticle,
      summaryPoints: [
        "先确认真实业务目标",
        "再建立可追溯的内容流程",
        "最后检查渠道草稿结果",
      ],
    });

    expect(html).toContain("01</span>先确认真实业务目标");
    expect(html).toContain("02</span>再建立可追溯的内容流程");
    expect(html).toContain("03</span>最后检查渠道草稿结果");
    expect(html).not.toContain("从明确目标开始：先确定业务目标和读者需求。");
  });

  it("rejects a dangling conditional clause in the summary action", () => {
    const brokenArticle = {
      ...validLiveArticle,
      cta: "如果企业正在梳理数据标准、跨部门流程或系统集成路径。",
    };

    expect(editorialEndingErrors(brokenArticle)).toContain(
      "总结行动建议必须是语义完整的独立句子；不能只写“如果/若/当……”条件从句",
    );
    const html = renderWechatHtml(brokenArticle);
    expect(html).not.toContain(brokenArticle.cta);
    expect(html).not.toContain('style="margin:12px 0 0;padding-left:12px');
  });

  it("accepts a complete conditional action sentence", () => {
    const article = {
      ...validLiveArticle,
      cta: "如果企业正在梳理系统集成路径，可以先完成数据与流程盘点。",
    };
    expect(editorialEndingErrors(article)).toEqual([]);
    const wechatHtml = renderWechatHtml(article);
    expect(wechatHtml).not.toContain(article.cta);
    expect(renderWebsiteHtml(article)).toContain("可以先完成数据与流程盘点。");
  });

  it("renders a configurable WeChat ending with safe recommendations", () => {
    const html = renderWechatHtml(
      validLiveArticle,
      [],
      undefined,
      undefined,
      undefined,
      {
        about: "这是可维护的极客跳动团队介绍，用于公众号文章结尾。",
        slogan: "长期陪伴业务持续成长",
        phone: "12345678",
        website: "www.geekdance.cn",
        address: "深圳市测试地址 19 楼",
        services: ["高端软件定制", "企业数字化转型"],
        recommendations: [
          { title: "往期文章一", url: "https://example.com/article" },
        ],
      },
    );
    expect(html).toContain("长期陪伴业务持续成长");
    expect(html).toContain('data-gd-recommendations="wechat"');
    expect(html.indexOf('data-gd-recommendations="wechat"')).toBeGreaterThan(
      html.indexOf("「主营业务」"),
    );
    expect(html).toContain("往期文章一");
    expect(html).toContain("https://example.com/article");
  });

  it("adds uploaded attachments to the evidence inventory", async () => {
    const result = await runContentPipeline(request, undefined, [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "stage7-reference.md",
        mimeType: "text/markdown",
        extractedText: "企业内容自动化必须保留人工审核与来源追溯。",
      },
    ]);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(
      result.evidence.some((item) => item.sourceType === "user_attachment"),
    ).toBe(true);
  });

  it("accepts any daily HH:mm schedule and rejects non-daily cron patterns", () => {
    const schedule = {
      name: "每日下午草稿",
      enabled: false,
      cronExpression: "37 14 * * *",
      timezone: "Asia/Shanghai",
      template: {
        topic: "AI 应用趋势",
        readerMode: "general",
        sourceRefs: [],
        imageMode: "geekhome",
        targets: ["official_site", "wechat"],
      },
    };
    expect(automationScheduleRequestSchema.parse(schedule).cronExpression).toBe(
      "37 14 * * *",
    );
    expect(() =>
      automationScheduleRequestSchema.parse({
        ...schedule,
        cronExpression: "*/5 * * * *",
      }),
    ).toThrow();
  });

  it("accepts all seven channels in content and automation contracts", () => {
    const targets = [
      "official_site",
      "wechat",
      "xiaohongshu",
      "zhihu",
      "toutiao",
      "baijiahao",
      "linkedin",
    ] as const;
    expect(targets.map((target) => channelSchema.parse(target))).toEqual(
      targets,
    );
    expect(browserDraftChannelSchema.parse("linkedin")).toBe("linkedin");
    expect(
      automationScheduleRequestSchema.parse({
        name: "七渠道人工复核任务",
        enabled: false,
        cronExpression: "0 8 * * *",
        timezone: "Asia/Shanghai",
        template: {
          topic: "企业 AI 产品开发",
          readerMode: "general",
          sourceRefs: [],
          imageMode: "generated",
          targets: [...targets],
        },
      }).template.targets,
    ).toEqual(targets);
  });

  it("validates image workshop source counts and rights confirmation", () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    expect(
      imageJobRequestSchema.parse({
        operationId,
        operation: "generate",
        prompt: "企业 AI 协作场景",
        ratio: "16:9",
      }).sourceAssetIds,
    ).toEqual([]);
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "remove_background",
        sourceAssetIds: [],
      }),
    ).toThrow();
    expect(
      imageJobRequestSchema.parse({
        operationId,
        operation: "wechat_cover_brand",
        sourceAssetIds: ["11111111-1111-4111-8111-111111111111"],
        ratio: "wechat_cover",
        wechatCoverRegions: {
          wide: { x: 0, y: 0.1, width: 1, height: 0.4 },
          square: { x: 0.1, y: 0, width: 0.8, height: 0.8 },
        },
      }).operation,
    ).toBe("wechat_cover_brand");
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "wechat_cover_brand",
        sourceAssetIds: ["11111111-1111-4111-8111-111111111111"],
        ratio: "wechat_cover",
        wechatCoverRegions: {
          wide: { x: 0.7, y: 0.1, width: 0.5, height: 0.4 },
        },
      }),
    ).toThrow();
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "wechat_cover_brand",
        sourceAssetIds: [],
      }),
    ).toThrow();
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "stitch",
        sourceAssetIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).toThrow();
    const composition = imageJobRequestSchema.parse({
      operationId,
      operation: "compose",
      sourceAssetIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    });
    expect(composition.sourceAssetIds).toHaveLength(2);
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "compose",
        sourceAssetIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).toThrow();
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "creative_stitch",
        sourceAssetIds: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
      }),
    ).toThrow();
    const logoOverlay = imageJobRequestSchema.parse({
      operationId,
      operation: "logo_overlay",
      sourceAssetIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      logoPlacement: { x: 0.7, y: 0.08, width: 0.2 },
    });
    expect(logoOverlay.logoPlacement).toEqual({
      x: 0.7,
      y: 0.08,
      width: 0.2,
    });
    expect(
      imageJobRequestSchema.parse({
        operationId,
        operation: "xiaohongshu_cover_text",
        sourceAssetIds: ["11111111-1111-4111-8111-111111111111"],
        prompt: "替换后的精确文字",
        textRegion: { x: 0.08, y: 0.15, width: 0.6, height: 0.18 },
        detectedText: "原标题",
      }).detectedText,
    ).toBe("原标题");
    expect(() =>
      imageJobRequestSchema.parse({
        operationId,
        operation: "compose",
        sourceAssetIds: [
          "11111111-1111-4111-8111-111111111111",
          "11111111-1111-4111-8111-111111111111",
        ],
        rightsConfirmed: true,
      }),
    ).toThrow();
  });

  it("prioritizes relevance before lower usage", () => {
    const result = selectMaterial({
      topic: "AI 智能体",
      title: "企业 AI 智能体",
      targetPlatform: "official_site",
      primaryTag: "AI",
      secondaryTags: ["智能体"],
      imageIntent: "cover",
      operationId: request.operationId,
      candidates: [
        {
          id: "irrelevant",
          title: "年会",
          url: "https://example.com/a.jpg",
          tags: ["活动"],
          usageCount: 0,
        },
        {
          id: "relevant",
          title: "智能体封面",
          url: "https://example.com/b.jpg",
          primaryTag: "AI",
          secondaryTags: ["智能体"],
          usageCount: 2,
        },
      ],
    });
    expect(result.selected?.id).toBe("relevant");
  });

  it("skips GeekHome images that exceed the official upload safety margin", () => {
    const result = selectMaterial({
      topic: "AI 智能体",
      title: "企业 AI 智能体",
      targetPlatform: "official_site",
      primaryTag: "AI",
      secondaryTags: ["智能体"],
      imageIntent: "cover",
      operationId: request.operationId,
      candidates: [
        {
          id: "oversized",
          title: "智能体大图",
          url: "https://example.com/large.jpg",
          primaryTag: "AI",
          secondaryTags: ["智能体"],
          fileSizeBytes: 10 * 1024 * 1024,
        },
        {
          id: "safe",
          title: "智能体封面",
          url: "https://example.com/safe.jpg",
          primaryTag: "AI",
          secondaryTags: ["智能体"],
          fileSizeBytes: 500 * 1024,
        },
      ],
    });
    expect(result.selected?.id).toBe("safe");
  });

  it("allows relevant GeekHome people images without an authorization flag", () => {
    const result = selectMaterial({
      topic: "新西兰市场观察",
      title: "从新西兰市场看企业数字化需求",
      targetPlatform: "official_site",
      primaryTag: "客户的故事",
      secondaryTags: ["新西兰"],
      imageIntent: "cover",
      operationId: request.operationId,
      candidates: [
        {
          id: "new-zealand-customer-story",
          title: "新西兰客户人物素材",
          url: "https://example.com/new-zealand-customer.jpg",
          primaryTag: "客户的故事",
          secondaryTags: ["新西兰"],
          containsPerson: true,
          authorized: false,
          usageCount: 0,
        },
      ],
    });
    expect(result.selected?.id).toBe("new-zealand-customer-story");
    expect(result.manualReview).toBe(false);
  });

  it("does not report a perfect QA score when no channel reaches QA", async () => {
    const result = await runContentPipeline(
      { ...request, targets: ["official_site"] },
      { ...mockPorts, searchMaterials: async () => [] },
    );
    expect(result.status).toBe("manual_review");
    expect(result.qaReport?.score).toBe(0);
  });

  it("builds valid channel-specific layouts", async () => {
    const result = await runContentPipeline(request);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(validateWebsiteHtml(result.websiteHtml ?? "").ok).toBe(true);
    expect(validateWechatHtml(result.wechatHtml ?? "").ok).toBe(true);
    expect(result.websiteHtml).not.toContain("geekdance-promo-board");
    expect(result.wechatHtml).toContain('data-gd-promo-version="text-v3"');
    expect(result.wechatHtml).toContain('data-gd-ending-divider="top"');
    expect(result.wechatHtml).toContain('data-gd-recommendations="wechat"');
    expect(result.wechatHtml).toContain('data-gd-brand-lockup="connected"');
    expect(result.wechatHtml).toContain(">GeekDance</span>");
    expect(result.wechatHtml).not.toContain(">Geek Dance</span>");
    expect(result.channelArtifacts.official_site?.article?.opening[0]).not.toBe(
      result.channelArtifacts.wechat?.article?.opening[0],
    );
    expect(result.templateVersions.official_site).toMatchObject({
      skillName: "gd-market-guanwang-auto",
      version: "1.0.0",
    });
    expect(result.templateVersions.wechat).toMatchObject({
      skillName: "gd-market-gzh-auto",
      version: "1.0.0",
    });
  });

  it("uses the explicit AI image path without falling back to GeekHome", async () => {
    const result = await runContentPipeline({
      ...request,
      operationId: "22222222-2222-4222-8222-222222222222",
      imageMode: "generated",
      targets: ["official_site"],
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.assets).toHaveLength(3);
    expect(
      result.assets.every((asset) =>
        asset.selected?.url?.includes("mock.openrouter.local"),
      ),
    ).toBe(true);
  });

  it("does not run generated chapter diagrams through the GeekHome relevance threshold", async () => {
    const generated = Array.from({ length: 3 }, (_, index) => ({
      id: `diagram-${index + 1}`,
      title: `章节结构图 ${index + 1}`,
      url: `https://aiops.geekdance.cn/api/public/assets/diagram-${index + 1}`,
      tags: ["确定性生成", "章节结构图"],
      usageCount: 0,
      authorized: true,
      containsPerson: false,
    }));
    const result = await runContentPipeline(
      {
        ...request,
        operationId: "24222222-2222-4222-8222-222222222222",
        topic: "企业知识库如何通过引用权限与检索记录保证答案可追溯",
        imageMode: "generated",
        includeGeekHome: false,
        targets: ["official_site"],
      },
      {
        ...mockPorts,
        generateImages: async () => generated,
      },
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.assets.map((asset) => asset.selected?.id)).toEqual([
      "diagram-1",
      "diagram-2",
      "diagram-3",
    ]);
    expect(result.assets.every((asset) => !asset.manualReview)).toBe(true);
  });

  it("keeps AI chapter diagrams as the primary path when GeekHome is enabled", async () => {
    const generateImages = vi.fn(mockPorts.generateImages);
    const searchMaterials = vi.fn(mockPorts.searchMaterials);
    const result = await runContentPipeline(
      {
        ...request,
        operationId: "23222222-2222-4222-8222-222222222222",
        imageMode: "generated",
        includeGeekHome: true,
        targets: ["official_site"],
      },
      { ...mockPorts, generateImages, searchMaterials },
    );
    expect(result.status).toBe("ready");
    expect(generateImages).toHaveBeenCalled();
    expect(searchMaterials).not.toHaveBeenCalled();
  });

  it("reports observable progress for research, writing, images and QA", async () => {
    const events: Array<{ phase: string; fraction: number; stage: string }> =
      [];
    const result = await runContentPipeline(
      {
        ...request,
        targets: ["official_site"],
        imageMode: "generated",
      },
      mockPorts,
      [],
      async ({ phase, fraction, stage }) => {
        events.push({ phase, fraction, stage });
      },
    );
    expect(result.status).toBe("ready");
    expect(
      events.some(
        (event) => event.phase === "research" && event.fraction === 1,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.phase === "official_site:write" && event.fraction === 1,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.phase === "official_site:assets" && event.fraction === 1,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.phase === "official_site:qa" && event.fraction === 1,
      ),
    ).toBe(true);
    expect(events.at(-1)?.stage).toBe("formatting");
  });

  it("executes only the website Skill when only website is selected", async () => {
    const write = vi.fn(mockPorts.write);
    const result = await runContentPipeline(
      { ...request, targets: ["official_site"] },
      { ...mockPorts, write },
    );
    expect(result.status).toBe("ready");
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls.every((call) => call[2] === "official_site")).toBe(
      true,
    );
    if (result.status !== "ready") return;
    expect(result.channelArtifacts.official_site?.status).toBe("ready");
    expect(result.channelArtifacts.wechat).toBeUndefined();
    expect(result.wechatHtml).toBeUndefined();
  });

  it("executes only the WeChat Skill when only WeChat is selected", async () => {
    const write = vi.fn(mockPorts.write);
    const result = await runContentPipeline(
      { ...request, targets: ["wechat"] },
      { ...mockPorts, write },
    );
    expect(result.status).toBe("ready");
    expect(write.mock.calls.every((call) => call[2] === "wechat")).toBe(true);
    if (result.status !== "ready") return;
    expect(result.channelArtifacts.wechat?.status).toBe("ready");
    expect(result.channelArtifacts.official_site).toBeUndefined();
    expect(result.websiteHtml).toBeUndefined();
    expect(result.wechatHtml).toContain('data-gd-promo-version="text-v3"');
  });

  it("builds an independent Xiaohongshu note and mobile preview", async () => {
    const write = vi.fn(mockPorts.write);
    const result = await runContentPipeline(
      { ...request, targets: ["xiaohongshu"] },
      { ...mockPorts, write },
    );
    expect(result.status).toBe("ready");
    expect(write.mock.calls.every((call) => call[2] === "xiaohongshu")).toBe(
      true,
    );
    if (result.status !== "ready") return;
    const artifact = result.channelArtifacts.xiaohongshu;
    expect(artifact?.note?.title.length).toBeLessThanOrEqual(20);
    expect(artifact?.note?.hashtags).toContain("极客跳动");
    expect(result.xiaohongshuHtml).toContain('data-gd-root="xiaohongshu-note"');
    expect(result.xiaohongshuHtml).not.toMatch(/立即发布|正式发布/);
  });

  it.each([
    ["zhihu", "zhihuHtml", "gd-market-zhihu-article"],
    ["toutiao", "toutiaoHtml", "gd-market-toutiao-article"],
    ["baijiahao", "baijiahaoHtml", "gd-market-baijiahao-article"],
    ["linkedin", "linkedinHtml", "gd-market-linkedin-article"],
  ] as const)(
    "builds an independent %s article draft artifact",
    async (channel, htmlField, skillName) => {
      const write = vi.fn(mockPorts.write);
      const result = await runContentPipeline(
        { ...request, targets: [channel] },
        { ...mockPorts, write },
      );
      expect(result.status).toBe("ready");
      expect(write.mock.calls.every((call) => call[2] === channel)).toBe(true);
      if (result.status !== "ready") return;
      expect(result.channelArtifacts[channel]?.status).toBe("ready");
      expect(result.channelArtifacts[channel]?.template.skillName).toBe(
        skillName,
      );
      expect(result[htmlField]).toContain('data-gd-root="website-article"');
      expect(result[htmlField]).not.toMatch(/立即发布|正式发布/);
    },
  );

  it("validates deterministic Xiaohongshu draft artifacts", () => {
    const note = buildXiaohongshuNote(validLiveArticle, request);
    const html = renderXiaohongshuHtml(note, [
      "https://example.com/1.jpg",
      "https://example.com/2.jpg",
      "https://example.com/3.jpg",
    ]);
    expect(validateXiaohongshuHtml(html).ok).toBe(true);
    expect(note.body.length).toBeLessThanOrEqual(780);
    expect(note.body).toContain("GeekDance｜数字产品落地观察");
    expect(note.body).toContain("01｜从明确目标开始");
    expect(note.body).toContain("极客跳动观察");
    expect(note.body).toContain(validLiveArticle.conclusion);
    expect(note.body).not.toMatch(/[^。！？!?；;…\n]$/u);
    expect(note.body).toMatch(/\n\n01｜/);
    expect(note.hashtags).toContain("GeekDance");
    expect(note.hashtags).toEqual(
      expect.arrayContaining([
        "极客跳动",
        "GeekDance",
        "技术团队",
        "企业数字化转型",
        "软件定制开发",
        "深圳APP开发公司哪家好",
        "深圳软件开发公司",
        "极客跳动靠谱",
      ]),
    );
    expect(note.hashtags.length).toBeLessThanOrEqual(12);
    expect(xiaohongshuNoteSchema.safeParse(note).success).toBe(true);
    expect(
      `${note.body}\n\n${note.hashtags.map((tag) => `#${tag}`).join(" ")}`
        .length,
    ).toBeLessThanOrEqual(780);
  });

  it("does not duplicate section numbers already present in AI headings", () => {
    const articleWithNumberedHeadings = {
      ...validLiveArticle,
      sections: validLiveArticle.sections.map((section, index) => ({
        ...section,
        heading: `${String(index + 1).padStart(2, "0")} ${section.heading}`,
      })),
    };
    const note = buildXiaohongshuNote(articleWithNumberedHeadings, request);

    expect(note.body).toContain("01｜从明确目标开始");
    expect(note.body).not.toMatch(/01｜01(?:\s|[、｜|.．:：])/);
    expect(note.body).not.toMatch(/02｜02(?:\s|[、｜|.．:：])/);
  });

  it("compresses long Xiaohongshu copy without cutting a sentence or dropping the ending", () => {
    const longArticle = {
      ...validLiveArticle,
      opening: Array.from(
        { length: 2 },
        () =>
          "企业知识库项目需要同时处理证据引用、身份权限、资料更新和异常审计，不能只关注回答是否流畅。",
      ),
      sections: Array.from({ length: 4 }, (_, index) => ({
        heading: `第${index + 1}个完整章节标题`,
        paragraphs: Array.from(
          { length: 3 },
          () =>
            "系统应先根据调用者身份过滤无权访问的资料，再检索可靠证据并组织答案。找不到足够证据时，应明确提示依据不足。",
        ),
        bullets: ["记录引用资料、访问身份和处理结果。"],
      })),
      observation:
        "极客跳动认为，答案可追溯和权限不越界必须作为同一项验收标准。",
      conclusion: "知识库 AI 的可信度来自完整证据、正确权限和持续审计。",
      cta: "先选一条高频问答流程做小范围验证。",
    };

    const note = buildXiaohongshuNote(longArticle, request);

    expect(note.body.length).toBeLessThanOrEqual(780);
    expect(note.body).toContain("01｜第1个完整章节标题");
    expect(note.body).toContain("04｜第4个完整章节标题");
    expect(note.body).toContain("极客跳动观察");
    expect(note.body).toContain(longArticle.conclusion);
    expect(note.body).toContain(longArticle.cta);
    expect(note.body).not.toMatch(/权限配置不$/u);
    expect(note.body).not.toMatch(/[^。！？!?；;…\n]$/u);
  });

  it("researches once but writes one independent article per selected channel", async () => {
    const research = vi.fn(mockPorts.research);
    const write = vi.fn(mockPorts.write);
    const result = await runContentPipeline(request, {
      ...mockPorts,
      research,
      write,
    });
    expect(result.status).toBe("ready");
    expect(research).toHaveBeenCalledTimes(1);
    expect(new Set(write.mock.calls.map((call) => call[2]))).toEqual(
      new Set(["official_site", "wechat"]),
    );
  });

  it("keeps a passing channel ready when the other channel needs review", async () => {
    const write = vi.fn(async (...args: Parameters<typeof mockPorts.write>) => {
      const article = await mockPorts.write(...args);
      return args[2] === "wechat" ? { ...article, title: "太短" } : article;
    });
    const result = await runContentPipeline(request, {
      ...mockPorts,
      write,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.channelArtifacts.official_site?.status).toBe("ready");
    expect(result.channelArtifacts.wechat?.status).toBe("manual_review");
    expect(result.qaReport.passed).toBe(false);
  });

  it("rejects articles that cite evidence IDs outside the evidence inventory", async () => {
    const result = await runContentPipeline(
      { ...request, targets: ["official_site"] },
      {
        ...mockPorts,
        write: async (...args) => ({
          ...(await mockPorts.write(...args)),
          evidenceIds: ["missing-evidence"],
        }),
      },
    );
    expect(result.status).toBe("manual_review");
    expect(result.qaReport?.errors.join(" ")).toContain("不存在的证据 ID");
  });

  it("拦截无证据否定市场价值的获客文章", async () => {
    const result = await runContentPipeline(
      { ...request, targets: ["official_site"] },
      {
        ...mockPorts,
        write: async (...args) => ({
          ...(await mockPorts.write(...args)),
          conclusion: "宠物服务 APP 没有市场空间，因此不值得开发。",
        }),
      },
    );
    expect(result.status).toBe("manual_review");
    expect(result.qaReport?.errors.join(" ")).toContain(
      "不得无证据否定市场或开发价值",
    );
    expect(result.qaReport?.errors.join(" ")).toContain("MVP 验证条件");
  });

  it("keeps immutable, auditable template references", () => {
    const website = getChannelTemplateRef("official_site");
    const wechat = getChannelTemplateRef("wechat");
    const xiaohongshu = getChannelTemplateRef("xiaohongshu");
    const zhihu = getChannelTemplateRef("zhihu");
    const toutiao = getChannelTemplateRef("toutiao");
    const baijiahao = getChannelTemplateRef("baijiahao");
    const linkedin = getChannelTemplateRef("linkedin");
    const xiaohongshuCase = getChannelTemplateRef("xiaohongshu", "case");
    expect(website.skillName).toBe("gd-market-guanwang-auto");
    expect(wechat.skillName).toBe("gd-market-gzh-auto");
    expect(xiaohongshu.skillName).toBe("gd-market-xiaohongshu-auto");
    expect(xiaohongshuCase.skillName).toBe("gd-market-article-example-style1");
    expect(xiaohongshu.version).toBe("1.2.0");
    expect(xiaohongshuCase.version).toBe("1.2.0");
    expect(zhihu.skillName).toBe("gd-market-zhihu-article");
    expect(toutiao.skillName).toBe("gd-market-toutiao-article");
    expect(baijiahao.skillName).toBe("gd-market-baijiahao-article");
    expect(linkedin.skillName).toBe("gd-market-linkedin-article");
    expect(website.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(wechat.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(xiaohongshu.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(zhihu.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(toutiao.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(baijiahao.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(linkedin.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks case content before research and writing", async () => {
    const result = await runContentPipeline({
      ...request,
      topic: "某客户 AI 系统交付案例",
    });
    expect(result.status).toBe("manual_review");
    if (result.status !== "manual_review") return;
    expect(result.route).toBe("xiaohongshu_case_workflow");
  });

  it("runs an explicitly selected, attachment-backed Xiaohongshu case", async () => {
    const caseRequest = contentJobRequestSchema.parse({
      ...request,
      topic: "宅邸青年 AI 房产顾问服务数字化平台案例",
      contentType: "case",
      caseStatus: "proposal",
      targets: ["xiaohongshu"],
      imageMode: "generated",
      attachmentIds: ["44444444-4444-4444-8444-444444444444"],
      caseVisualTypes: ["cover", "function", "architecture"],
    });
    const result = await runContentPipeline(
      caseRequest,
      {
        ...mockPorts,
        generateImages: async () =>
          ["cover", "function", "architecture"].map((type, index) => ({
            id: `case-${type}`,
            title: type,
            url: `https://example.com/${index}-${type}.jpg`,
            tags: ["小红书", "项目案例", type],
            usageCount: 0,
            authorized: true,
            containsPerson: false,
          })),
      },
      [
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: "project.md",
          mimeType: "text/markdown",
          extractedText: "本文件描述拟建设的 AI 房产顾问平台功能方案。",
        },
      ],
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.templateVersions.xiaohongshu?.skillName).toBe(
      "gd-market-article-example-style1",
    );
    expect(
      result.channelArtifacts.xiaohongshu?.assets.map(
        (asset) => asset.selected?.id,
      ),
    ).toEqual(["case-cover", "case-function", "case-architecture"]);
  });

  it("caps harmless case-diagram collection overflow before validation", () => {
    const attachmentId = "44444444-4444-4444-8444-444444444444";
    const evidence = [
      {
        id: "case-source-1",
        title: "项目附件",
        url: `attachment://${attachmentId}`,
        sourceType: "internal" as const,
        claims: ["附件确认项目功能"],
        accessedAt: new Date().toISOString(),
      },
    ];
    const caseRequest = contentJobRequestSchema.parse({
      ...request,
      contentType: "case",
      caseStatus: "proposal",
      targets: ["xiaohongshu"],
      imageMode: "generated",
      attachmentIds: [attachmentId],
      caseVisualTypes: ["cover", "function"],
    });
    const specs = validateCaseDiagramSpecs(
      {
        specs: [
          {
            diagramType: "function",
            projectName: "宅邸青年",
            title: "功能全览图",
            subtitle: "附件支持的项目功能",
            sequence: [],
            modules: Array.from({ length: 11 }, (_, index) => ({
              title: `功能模块${index + 1}`,
              items: ["附件确认功能"],
              evidenceIds: ["case-source-1"],
            })),
            supports: [],
            sourceAttachmentIds: [attachmentId],
          },
        ],
      },
      caseRequest,
      evidence,
      [
        {
          id: attachmentId,
          name: "project.md",
          mimeType: "text/markdown",
          extractedText: "项目功能说明",
        },
      ],
    );
    expect(specs[0]?.modules).toHaveLength(10);
  });

  it("caps harmless model-generated case-diagram text overflow", () => {
    const attachmentId = "44444444-4444-4444-8444-444444444444";
    const evidence = [
      {
        id: "case-source-1",
        title: "项目附件",
        url: `attachment://${attachmentId}`,
        sourceType: "internal" as const,
        claims: ["附件确认项目功能"],
        accessedAt: new Date().toISOString(),
      },
    ];
    const caseRequest = contentJobRequestSchema.parse({
      ...request,
      contentType: "case",
      caseStatus: "proposal",
      targets: ["xiaohongshu"],
      imageMode: "generated",
      attachmentIds: [attachmentId],
      caseVisualTypes: ["cover", "function"],
    });
    const specs = validateCaseDiagramSpecs(
      {
        specs: [
          {
            diagramType: "function",
            projectName: "项目".repeat(30),
            title: "从访客咨询到人工顾问接管以及预约看房的完整产品功能全览图",
            subtitle:
              "依据附件整理移动端需求采集、房源匹配、顾问接管、预约看房与运营后台协同的方案结构，不代表项目已经上线",
            sequence: ["咨询流程".repeat(8)],
            modules: Array.from({ length: 3 }, (_, index) => ({
              title: `功能模块${index + 1}`.repeat(8),
              items: ["附件功能描述".repeat(8)],
              evidenceIds: ["case-source-1"],
            })),
            supports: ["项目支撑能力".repeat(8)],
            sourceAttachmentIds: [attachmentId],
          },
        ],
      },
      caseRequest,
      evidence,
      [
        {
          id: attachmentId,
          name: "project.md",
          mimeType: "text/markdown",
          extractedText: "项目功能说明",
        },
      ],
    );
    expect(Array.from(specs[0]!.projectName)).toHaveLength(40);
    expect(Array.from(specs[0]!.sequence[0]!)).toHaveLength(16);
    expect(Array.from(specs[0]!.modules[0]!.title)).toHaveLength(18);
    expect(Array.from(specs[0]!.modules[0]!.items[0]!)).toHaveLength(24);
    expect(Array.from(specs[0]!.supports[0]!)).toHaveLength(20);
  });

  it("rejects delivery claims in a proposal case", async () => {
    const caseRequest = contentJobRequestSchema.parse({
      ...request,
      topic: "房产顾问平台项目案例",
      contentType: "case",
      caseStatus: "proposal",
      targets: ["xiaohongshu"],
      imageMode: "generated",
      attachmentIds: ["44444444-4444-4444-8444-444444444444"],
      caseVisualTypes: ["cover", "function", "architecture"],
    });
    const result = await runContentPipeline(
      caseRequest,
      {
        ...mockPorts,
        write: async (...args) => ({
          ...(await mockPorts.write(...args)),
          conclusion: "系统已经上线并成功交付。",
        }),
        generateImages: async () =>
          ["cover", "function", "architecture"].map((type) => ({
            id: type,
            title: type,
            url: `https://example.com/${type}.jpg`,
            tags: ["小红书", "项目案例", type],
            usageCount: 0,
          })),
      },
      [
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: "proposal.md",
          mimeType: "text/markdown",
          extractedText: "本文件为项目方案。",
        },
      ],
    );
    expect(result.status).toBe("manual_review");
    expect(result.qaReport?.errors.join(" ")).toContain("方案型案例不得声称");
  });

  it("keeps usable GeekHome results when one parallel query is interrupted", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("terminated");
        return new Response(
          JSON.stringify({
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    materials: [
                      {
                        id: "asset-1",
                        title: "AI Agent 封面",
                        url: "https://assets.example/agent.png",
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          { status: 200 },
        );
      }),
    );
    const materials = await searchGeekHomeMaterials(
      {
        geekHomeUrl: "https://geekhome.example/mcp",
        geekHomeToken: "test-token",
      },
      request,
    );
    expect(materials.map((item) => item.id)).toContain("asset-1");
  });

  it("sends only parameters supported by GPT-5.6 Sol", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    evidence: [
                      {
                        id: "source-1",
                        title: "OpenRouter documentation",
                        url: "https://openrouter.ai/docs",
                        sourceType: "authoritative",
                        claims: ["OpenRouter provides a compatible API"],
                        accessedAt: new Date().toISOString(),
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await ports.research({ ...request, targets: ["official_site"] }, []);
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody).toMatchObject({
      model: "openai/gpt-5.6-sol",
      response_format: { type: "json_object" },
    });
  });

  it("uses the official OpenAI Responses API for GPT-5.6 Sol", async () => {
    let requestedUrl = "";
    let requestBody: Record<string, any> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requestedUrl = String(url);
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: "gpt-5.6-sol",
            usage: { total_tokens: 321 },
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ evidence: liveEvidence }),
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const usage: Array<{ totalTokens: number; costCents: number }> = [];
    const ports = createLivePorts({
      textProvider: "openai",
      openRouterApiKey: "sk-test",
      openRouterModel: "gpt-5.6-sol",
      openRouterTextBaseUrl: "https://api.openai.com/v1",
      openAiReasoningEffort: "medium",
      geekHomeUrl: "",
      geekHomeToken: "",
      usageRecorder: (value) => {
        usage.push(value);
      },
    });
    await expect(
      ports.research({ ...request, targets: ["official_site"] }, []),
    ).resolves.toEqual(liveEvidence);
    expect(requestedUrl).toBe("https://api.openai.com/v1/responses");
    expect(requestBody).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium" },
      tools: [{ type: "web_search" }],
      store: false,
    });
    expect(requestBody).not.toHaveProperty("text");
    expect(requestBody).not.toHaveProperty("plugins");
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody.input[0]).toMatchObject({
      role: "system",
      content: [{ type: "input_text" }],
    });
    expect(usage).toEqual([{ totalTokens: 321, costCents: 0 }]);
  });

  it("keeps GPT-5.6 Sol for writing while falling back only the web research model", async () => {
    const requestBodies: Array<Record<string, any>> = [];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      requestBodies.push(body);
      if (requestBodies.length < 2)
        return new Response(
          JSON.stringify({
            error: {
              code: "unsupported_tool",
              message: "Web search is unavailable for this request",
            },
          }),
          { status: 400 },
        );
      return new Response(
        JSON.stringify({
          model: "gpt-5.4",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ evidence: liveEvidence }),
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const ports = createLivePorts({
      textProvider: "openai",
      openRouterApiKey: "sk-test",
      openRouterModel: "gpt-5.6-sol",
      openAiResearchFallbackModel: "gpt-5.4",
      geekHomeUrl: "",
      geekHomeToken: "",
    });

    await expect(
      ports.research({ ...request, targets: ["official_site"] }, []),
    ).resolves.toEqual(liveEvidence);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toMatchObject({
      model: "gpt-5.6-sol",
      tools: [{ type: "web_search" }],
    });
    expect(requestBodies[0]).not.toHaveProperty("text");
    expect(requestBodies[1]).toMatchObject({
      model: "gpt-5.4",
      tools: [{ type: "web_search" }],
    });
    expect(requestBodies[1]).not.toHaveProperty("text");
  });

  it("normalizes equivalent Qwen evidence fields before schema validation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "qwen/qwen3.7-plus",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    data: {
                      sources: [
                        {
                          source_id: "source-1",
                          name: "OpenRouter documentation",
                          link: "https://openrouter.ai/docs",
                          type: "official",
                          claim: "OpenRouter provides a compatible API",
                          retrievedAt: liveEvidence[0]!.accessedAt,
                        },
                      ],
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "qwen/qwen3.7-plus",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await expect(
      ports.research({ ...request, targets: ["official_site"] }, []),
    ).resolves.toEqual(liveEvidence);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes equivalent Qwen article fields before schema validation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "qwen/qwen3.7-plus",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    article: {
                      headline: validLiveArticle.title,
                      description: validLiveArticle.description,
                      introduction: validLiveArticle.opening.join("\n"),
                      bodySections: validLiveArticle.sections.map(
                        (section) => ({
                          title: section.heading,
                          content: section.paragraphs.join("\n"),
                          points: section.bullets.join("\n"),
                        }),
                      ),
                      insight: validLiveArticle.observation,
                      summary: validLiveArticle.conclusion,
                      callToAction: validLiveArticle.cta,
                      citations: [{ id: "source-1" }],
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "qwen/qwen3.7-plus",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    const article = await ports.write(
      { ...request, targets: ["official_site"] },
      liveEvidence,
      "official_site",
    );
    expect(article).toEqual(validLiveArticle);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes common Qwen article shape drift deterministically", async () => {
    const sections = Array.from({ length: 6 }, (_, index) => ({
      title: `章节 ${index + 1}`,
      content: [{ text: `第 ${index + 1} 节正文。` }],
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen/qwen3.7-plus",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      headline: validLiveArticle.title,
                      description: validLiveArticle.description,
                      introduction: "这是一段完整开场。",
                      bodySections: sections,
                      insight: validLiveArticle.observation,
                      summary: validLiveArticle.conclusion,
                      callToAction: validLiveArticle.cta,
                      citations: [{ source_id: "source-1" }],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "qwen/qwen3.7-plus",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    const article = await ports.write(
      { ...request, targets: ["official_site"] },
      liveEvidence,
      "official_site",
    );
    expect(article.opening).toHaveLength(2);
    expect(article.sections).toHaveLength(5);
    expect(article.sections[0]?.paragraphs).toEqual(["第 1 节正文。"]);
    expect(article.sections[0]?.bullets).toEqual([]);
    expect(article.sections[4]?.paragraphs).toEqual([
      "第 5 节正文。",
      "第 6 节正文。",
    ]);
    expect(article.evidenceIds).toEqual(["source-1"]);
  });

  it("repairs an invalid Qwen article shape once without inventing evidence", async () => {
    const responses = [
      {
        title: validLiveArticle.title,
        description: validLiveArticle.description,
        opening: validLiveArticle.opening[0],
        sections: validLiveArticle.sections.slice(0, 1),
        observation: validLiveArticle.observation,
        conclusion: validLiveArticle.conclusion,
        cta: validLiveArticle.cta,
        evidenceIds: "source-1",
      },
      validLiveArticle,
    ];
    const requestBodies: Array<Record<string, any>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const content = responses.shift();
        return new Response(
          JSON.stringify({
            model: "qwen/qwen3.7-plus",
            choices: [{ message: { content: JSON.stringify(content) } }],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "qwen/qwen3.7-plus",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    const article = await ports.write(
      { ...request, targets: ["official_site"] },
      liveEvidence,
      "official_site",
    );
    expect(article).toEqual(validLiveArticle);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]?.messages[0]?.content).toContain(
      "不增加事实，不增加证据",
    );
    expect(requestBodies[1]?.messages[1]?.content).toContain(
      '允许使用的 evidenceIds：["source-1"]',
    );
  });

  it("reports a channel article schema failure after the bounded repair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "qwen/qwen3.7-plus",
              choices: [
                { message: { content: JSON.stringify({ title: "" }) } },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "qwen/qwen3.7-plus",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await expect(
      ports.write(
        { ...request, targets: ["official_site"] },
        liveEvidence,
        "official_site",
      ),
    ).rejects.toThrow("ARTICLE_OUTPUT_SCHEMA_INVALID");
  });

  it("returns an actionable OpenRouter HTTP failure code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await expect(
      ports.research({ ...request, targets: ["official_site"] }, []),
    ).rejects.toThrow("OPENROUTER_HTTP_400");
  });

  it("falls back only when the requested model is forbidden", async () => {
    const requests: Array<{ model: string; plugins?: unknown[] }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          plugins?: unknown[];
        };
        requests.push(body);
        if (requests.length <= 2)
          return new Response(
            JSON.stringify({ error: { message: "model access forbidden" } }),
            { status: 403 },
          );
        return new Response(
          JSON.stringify({
            model: "openai/gpt-5.4",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    evidence: [
                      {
                        id: "source-1",
                        title: "OpenRouter documentation",
                        url: "https://openrouter.ai/docs",
                        sourceType: "authoritative",
                        claims: ["OpenRouter provides a compatible API"],
                        accessedAt: new Date().toISOString(),
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      openRouterFallbackModels: ["openai/gpt-5.4"],
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await ports.research({ ...request, targets: ["official_site"] }, []);
    expect(requests).toEqual([
      expect.objectContaining({
        model: "openai/gpt-5.6-sol",
        plugins: [{ id: "web", max_results: 8 }],
      }),
      expect.objectContaining({
        model: "openai/gpt-5.4",
        plugins: [{ id: "web", max_results: 8 }],
      }),
      expect.objectContaining({ model: "openai/gpt-5.4" }),
    ]);
    expect(requests[2]).not.toHaveProperty("plugins");
  });

  it("retries a generic research 403 without Web Search before changing models", async () => {
    const requests: Array<{ model: string; plugins?: unknown[] }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          plugins?: unknown[];
        };
        requests.push(body);
        if (requests.length === 1)
          return new Response(
            JSON.stringify({ error: { message: "Request forbidden" } }),
            { status: 403 },
          );
        return new Response(
          JSON.stringify({
            model: "openai/gpt-5.6-sol",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    evidence: [
                      {
                        id: "source-1",
                        title: "OpenRouter documentation",
                        url: "https://openrouter.ai/docs",
                        sourceType: "authoritative",
                        claims: ["OpenRouter provides a compatible API"],
                        accessedAt: new Date().toISOString(),
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      openRouterFallbackModels: ["openai/gpt-5.4"],
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await ports.research({ ...request, targets: ["official_site"] }, []);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: "openai/gpt-5.6-sol",
      plugins: [{ id: "web", max_results: 8 }],
    });
    expect(requests[1]).toMatchObject({ model: "openai/gpt-5.6-sol" });
    expect(requests[1]).not.toHaveProperty("plugins");
  });

  it("classifies a structured provider routing failure without blaming model access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: "No provider available",
                metadata: { provider_name: "router" },
              },
            }),
            { status: 403 },
          ),
      ),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await expect(
      ports.research({ ...request, targets: ["official_site"] }, []),
    ).rejects.toThrow("OPENROUTER_HTTP_403:PROVIDER_UNAVAILABLE");
  });

  it("tries configured fallback models after a generic edge 403", async () => {
    const requestedModels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requestedModels.push(body.model);
        if (requestedModels.length <= 2)
          return new Response(
            JSON.stringify({ error: { code: 403, message: "Forbidden" } }),
            { status: 403 },
          );
        return new Response(
          JSON.stringify({
            model: "openai/gpt-5.4",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    evidence: [
                      {
                        id: "source-1",
                        title: "OpenRouter documentation",
                        url: "https://openrouter.ai/docs",
                        sourceType: "authoritative",
                        claims: ["OpenRouter provides a compatible API"],
                        accessedAt: new Date().toISOString(),
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      openRouterFallbackModels: ["openai/gpt-5.4"],
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await ports.research({ ...request, targets: ["official_site"] }, []);
    expect(requestedModels).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.4",
    ]);
  });

  it("uses the next distinct fallback after repeated upstream 5xx failures", async () => {
    vi.useFakeTimers();
    const requestedModels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requestedModels.push(body.model);
        if (body.model === "qwen/qwen3.7-plus")
          return new Response(
            JSON.stringify({ error: { message: "upstream unavailable" } }),
            { status: 503 },
          );
        return new Response(
          JSON.stringify({
            model: "qwen/qwen3.5-plus-20260420",
            choices: [
              {
                message: {
                  content: JSON.stringify({ evidence: liveEvidence }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "qwen/qwen3.7-plus",
      openRouterFallbackModels: [
        "qwen/qwen3.7-plus",
        "qwen/qwen3.5-plus-20260420",
      ],
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    const research = ports.research(
      { ...request, targets: ["official_site"] },
      [],
    );
    await vi.runAllTimersAsync();
    await expect(research).resolves.toEqual(liveEvidence);
    expect(requestedModels).toEqual([
      "qwen/qwen3.7-plus",
      "qwen/qwen3.7-plus",
      "qwen/qwen3.7-plus",
      "qwen/qwen3.7-plus",
      "qwen/qwen3.5-plus-20260420",
    ]);
  });

  it("routes a provider TOS failure to Qwen while preserving Web Search", async () => {
    const requests: Array<Record<string, any>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        requests.push(body);
        if (requests.length === 1)
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message:
                  "The request is prohibited due to a violation of provider Terms Of Service.",
              },
            }),
            { status: 403 },
          );
        return new Response(
          JSON.stringify({
            model: "qwen/qwen3.7-plus",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    evidence: [
                      {
                        id: "source-1",
                        title: "OpenRouter documentation",
                        url: "https://openrouter.ai/docs",
                        sourceType: "authoritative",
                        claims: ["OpenRouter provides a compatible API"],
                        accessedAt: new Date().toISOString(),
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const ports = createLivePorts({
      openRouterApiKey: "test-key",
      openRouterModel: "openai/gpt-5.6-sol",
      openRouterFallbackModels: ["qwen/qwen3.7-plus"],
      openRouterProviderOrder: ["Azure", "OpenAI"],
      geekHomeUrl: "",
      geekHomeToken: "",
    });
    await ports.research({ ...request, targets: ["official_site"] }, []);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: "openai/gpt-5.6-sol",
      provider: { order: ["Azure", "OpenAI"] },
      plugins: [{ id: "web", max_results: 8 }],
    });
    expect(requests[1]).toMatchObject({
      model: "qwen/qwen3.7-plus",
      plugins: [{ id: "web", max_results: 8 }],
    });
    expect(requests[1]).not.toHaveProperty("provider");
  });
});
