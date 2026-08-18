import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentJobRequestSchema, coreArticleSchema } from "@geekdance/shared";
import {
  attachmentImageSources,
  buildContentImagePrompts,
  finalizeArticleSectionDiagram,
  generateContentImages,
  planArticleIllustrations,
} from "../src/content-images.js";
import {
  articleSectionDiagramLabels,
  renderArticleSectionDiagram,
} from "../src/case-diagrams.js";
import sharp from "sharp";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("content image references", () => {
  it("passes uploaded image attachments to the cover generator", () => {
    const sources = attachmentImageSources([
      {
        id: "image-1",
        name: "product-screen.png",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from("screen").toString("base64")}`,
      },
      {
        id: "document-1",
        name: "case.pdf",
        mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${Buffer.from("document").toString("base64")}`,
      },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.mime).toBe("image/png");
    expect(Buffer.from(sources[0]!.bytes).toString()).toBe("screen");
  });

  it("builds every chapter illustration prompt from that chapter's heading and paragraphs", () => {
    const request = contentJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      topic: "企业定制软件的经营收益",
      contentType: "general",
      readerMode: "general",
      sourceRefs: [],
      attachmentIds: [],
      targets: ["official_site", "wechat"],
      imageMode: "generated",
      confirmDraft: true,
    });
    const article = coreArticleSchema.parse({
      title: "定制软件真正为企业带来的五类经营收益",
      description: "从效率、成本、数据、客户体验和经营能力分析收益。",
      opening: ["企业软件应解决经营问题。", "功能数量不等于业务价值。"],
      sections: [
        {
          heading: "减少订单重复录入",
          paragraphs: [
            "销售订单自动流转到仓库与财务，减少人工抄录。",
            "运营人员可以直接查看订单状态。",
          ],
          bullets: [],
        },
        {
          heading: "建立统一客户数据",
          paragraphs: ["各渠道客户记录合并到同一档案。"],
          bullets: [],
        },
        {
          heading: "让经营决策可追踪",
          paragraphs: ["看板展示交付周期和订单转化趋势。"],
          bullets: [],
        },
      ],
      observation: "系统需要贴合业务流程。",
      conclusion: "定制软件的价值来自持续改善经营。",
      cta: "从一个高频且可验收的流程开始。",
      evidenceIds: [],
    });

    const result = buildContentImagePrompts(request, article);

    expect(result.ratio).toBe("4:3");
    expect(result.prompts.length).toBeGreaterThan(0);
    expect(result.prompts.join("\n")).toContain(
      "值得视觉化的章节：减少订单重复录入",
    );
    expect(result.prompts.join("\n")).toContain("销售订单自动流转到仓库与财务");
    expect(result.prompts[0]).toContain("4:3 横版纯白背景");
    expect(result.prompts[0]).toContain("禁止固定套用卡片模板");
    expect(result.prompts[0]).toContain("人物、人像、假界面");
    expect(result.prompts[0]).toContain("绝对不能出现任何文字");
    expect(result.prompts[0]).toContain("严禁把它们画成文字");
    expect(result.plans).toContainEqual(
      expect.objectContaining({ sectionIndex: 0, visualIntent: "process" }),
    );
    expect(result.prompts.join("\n")).not.toContain("封面图。");
    expect(articleSectionDiagramLabels(article.sections[0]!)).toContain(
      "销售订单自动流转到仓库与财务，减少人工抄录",
    );
  });

  it("keeps the chapter canvas at full target size while applying the logo", async () => {
    const source = await sharp({
      create: {
        width: 1200,
        height: 900,
        channels: 4,
        background: "#fffdfc",
      },
    })
      .png()
      .toBuffer();
    const logo = await sharp({
      create: {
        width: 320,
        height: 100,
        channels: 4,
        background: "#e60012",
      },
    })
      .png()
      .toBuffer();

    const output = await finalizeArticleSectionDiagram(
      new Uint8Array(source),
      new Uint8Array(logo),
      "4:3",
    );
    const metadata = await sharp(output).metadata();

    expect(metadata).toMatchObject({
      width: 1200,
      height: 900,
      format: "jpeg",
      chromaSubsampling: "4:4:4",
    });

    const { data, info } = await sharp(output)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    expect(pixel(1_030, 80)?.[0]).toBeGreaterThan(180);
    expect(pixel(1_030, 80)?.[1]).toBeLessThan(80);
    expect(pixel(1_030, 790).every((channel) => channel > 245)).toBe(true);
  });

  it("calls gpt-image-2 for six distinct shared layouts and records true provider metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gd-content-images-"));
    temporaryDirectories.push(directory);
    const logoPath = join(directory, "logo.png");
    await writeFile(
      logoPath,
      await sharp({
        create: {
          width: 320,
          height: 100,
          channels: 4,
          background: "#da251c",
        },
      })
        .png()
        .toBuffer(),
    );
    const generatedImage = new Uint8Array(
      await sharp({
        create: {
          width: 1536,
          height: 1152,
          channels: 4,
          background: "#ffffff",
        },
      })
        .png()
        .toBuffer(),
    );
    const request = contentJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      topic: "企业订单协同",
      contentType: "general",
      readerMode: "general",
      sourceRefs: [],
      attachmentIds: [],
      targets: ["official_site", "wechat", "xiaohongshu"],
      imageMode: "generated",
      confirmDraft: true,
    });
    const article = coreArticleSchema.parse({
      title: "企业订单协同的实施路径",
      description: "梳理订单从销售到交付的过程与差异。",
      opening: ["订单需要跨部门协同。", "信息必须持续流转。"],
      sections: [
        {
          heading: "需求到验收的实施流程",
          paragraphs: [
            "先确认需求，再建立基线，然后按阶段验收，最后形成反馈闭环。",
          ],
          bullets: ["确认需求", "建立基线", "阶段验收"],
        },
        {
          heading: "标准产品与定制开发的差异",
          paragraphs: ["两种方案在周期、成本和适配度上存在差异。"],
          bullets: ["周期", "成本", "适配度"],
        },
        {
          heading: "形成持续反馈闭环",
          paragraphs: ["交付后持续收集反馈并推动下一轮优化。"],
          bullets: [],
        },
      ],
      observation: "视觉化应服务理解。",
      conclusion: "选择应回到业务目标。",
      cta: "先梳理一条可验收流程。",
      evidenceIds: [],
    });
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }),
    };
    const aiImageGenerator = vi.fn(async () => ({
      outputs: [generatedImage],
      costCents: 7,
    }));

    const candidates = await generateContentImages(
      {
        db: db as never,
        createdBy: "22222222-2222-4222-8222-222222222222",
        contentJobId: "33333333-3333-4333-8333-333333333333",
        storageDir: directory,
        imageServiceUrl: "http://image-service",
        logoPath,
        articleIllustrationLogoPath: logoPath,
        mascotPath: logoPath,
        publicBaseUrl: "https://example.com/assets",
        publicSecret: "test-secret",
        providerMode: "openai",
        imageApiKey: "test-key",
        imageBaseUrl: "https://api.openai.example/v1",
        model: "gpt-image-2",
        allowedResultHosts: [],
        aiImageGenerator,
      },
      request,
      article,
    );

    expect(candidates).toHaveLength(6);
    expect(aiImageGenerator).toHaveBeenCalledTimes(7);
    const inlineCalls = aiImageGenerator.mock.calls.filter((call) => {
      const [, input] = call as unknown as [unknown, { ratio: string }];
      return input.ratio === "4:3";
    });
    expect(inlineCalls).toHaveLength(6);
    for (const call of inlineCalls) {
      const [options, input] = call as unknown as [
        { providerMode: string; model: string; promptOverride: string },
        { ratio: string; quality: string },
      ];
      expect(options).toMatchObject({
        providerMode: "openai",
        model: "gpt-image-2",
      });
      expect(options.promptOverride).toContain("不得含任何可读或不可读文字");
      expect(
        options.promptOverride.includes("不能复刻前图构图") ||
          options.promptOverride.includes("本篇第一张图"),
      ).toBe(true);
      expect(input).toMatchObject({ ratio: "4:3", quality: "high" });
    }
    const coverCall = aiImageGenerator.mock.calls.find((call) => {
      const [, input] = call as unknown as [unknown, { ratio: string }];
      return input.ratio === "3:4";
    });
    expect(coverCall).toBeDefined();
    expect(coverCall?.[0]).toMatchObject({
      providerMode: "openai",
      model: "gpt-image-2",
      promptOverride: expect.stringContaining("独立的小红书 3:4 竖版封面"),
    });
    expect(coverCall?.[1]).toMatchObject({ ratio: "3:4", quality: "high" });
    const assetInserts = queries.filter((query) =>
      query.sql.includes("INSERT INTO assets"),
    );
    expect(assetInserts).toHaveLength(7);
    expect(
      assetInserts.slice(0, 6).every((query) => query.values?.[2] === "openai"),
    ).toBe(true);
    const metadata = JSON.parse(String(assetInserts[0]?.values?.[5]));
    expect(metadata).toMatchObject({
      model: "gpt-image-2",
      provider: "openai",
      generationMode: "image_2_exact_text_overlay",
      textRendering: "deterministic_article_source",
      generatedTextureSanitized: true,
    });
    const storedImage = await readFile(
      join(directory, String(assetInserts[0]?.values?.[3])),
    );
    expect(await sharp(storedImage).metadata()).toMatchObject({
      width: 1200,
      height: 900,
    });
    const coverInsert = assetInserts.find(
      (query) => query.values?.length === 4,
    );
    expect(coverInsert).toBeDefined();
    expect(JSON.parse(String(coverInsert?.values?.[3]))).toMatchObject({
      role: "cover",
      targetChannel: "xiaohongshu",
      ratio: "3:4",
      width: 1200,
      height: 1600,
      titleFontWeight: 700,
      bodyFontFamily: "Alibaba PuHuiTi 2.0",
    });
  });

  it("does not silently replace a production image-2 failure with a template", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gd-content-images-failure-"),
    );
    temporaryDirectories.push(directory);
    const logoPath = join(directory, "logo.png");
    await writeFile(
      logoPath,
      await sharp({
        create: { width: 100, height: 40, channels: 4, background: "#da251c" },
      })
        .png()
        .toBuffer(),
    );
    const request = contentJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      topic: "流程闭环",
      contentType: "general",
      readerMode: "general",
      sourceRefs: [],
      attachmentIds: [],
      targets: ["official_site"],
      imageMode: "generated",
      confirmDraft: true,
    });
    const article = coreArticleSchema.parse({
      title: "流程闭环",
      description: "流程说明。",
      opening: ["开始。", "继续。"],
      sections: [
        {
          heading: "从需求到验收",
          paragraphs: ["先确认需求，然后实施，最后验收并反馈。"],
          bullets: ["需求", "实施", "验收"],
        },
        {
          heading: "统一协作信息",
          paragraphs: ["所有成员使用一致的信息。"],
          bullets: [],
        },
        {
          heading: "记录后续改进",
          paragraphs: ["交付后记录需要继续改进的事项。"],
          bullets: [],
        },
      ],
      observation: "观察。",
      conclusion: "结论。",
      cta: "行动。",
      evidenceIds: [],
    });

    await expect(
      generateContentImages(
        {
          db: { query: vi.fn() } as never,
          createdBy: "22222222-2222-4222-8222-222222222222",
          contentJobId: "33333333-3333-4333-8333-333333333333",
          storageDir: directory,
          imageServiceUrl: "http://image-service",
          logoPath,
          mascotPath: logoPath,
          publicBaseUrl: "https://example.com/assets",
          publicSecret: "test-secret",
          providerMode: "openai",
          imageApiKey: "test-key",
          imageBaseUrl: "https://api.openai.example/v1",
          model: "gpt-image-2",
          allowedResultHosts: [],
          aiImageGenerator: vi.fn(async () => {
            throw new Error("OPENAI_IMAGE_503");
          }),
        },
        request,
        article,
      ),
    ).rejects.toThrow("OPENAI_IMAGE_503");
  });

  it("renders the chapter heading, original facts and conclusion into the illustration", async () => {
    const article = coreArticleSchema.parse({
      title: "企业订单协同为什么需要统一流程",
      description: "从订单录入、库存确认到财务结算梳理业务关系。",
      opening: ["订单流转需要跨部门协同。", "信息断点会带来重复确认。"],
      sections: [
        {
          heading: "订单从销售流转到仓库与财务",
          paragraphs: [
            "销售确认订单后，仓库同步核对库存。",
            "财务根据交付状态完成结算。",
          ],
          bullets: ["销售确认订单", "仓库核对库存", "财务完成结算"],
        },
        {
          heading: "统一订单状态定义",
          paragraphs: ["各部门使用相同的订单状态。"],
          bullets: [],
        },
        {
          heading: "保留变更和交付记录",
          paragraphs: ["每次订单变更都形成可追踪记录。"],
          bullets: [],
        },
      ],
      observation: "流程信息应保持一致。",
      conclusion: "统一流程能够减少重复确认。",
      cta: "先梳理一条可验收的订单流程。",
      evidenceIds: [],
    });

    const rendered = await renderArticleSectionDiagram(
      article,
      article.sections[0]!,
      0,
      "4:3",
      Buffer.from("approved-logo"),
    );
    const svg = rendered.svg.toString("utf8");
    const metadata = await sharp(rendered.png).metadata();

    expect(svg).toContain("订单从销售流转到仓库与财务");
    expect(svg).toContain("销售确认订单");
    expect(svg).toContain("仓库核对库存");
    expect(svg).toContain("财务完成结算");
    expect(svg).toContain('data-diagram-type="article-section"');
    expect(svg).toContain('data-diagram-layout="process"');
    expect(svg).toContain('data-gd-company-logo="true"');
    expect(svg).toContain('data-gd-logo-position="top-right"');
    expect(metadata).toMatchObject({ width: 1200, height: 900, format: "png" });
  });

  it("produces six non-repeating visual frameworks while retaining structural chapters", () => {
    const article = coreArticleSchema.parse({
      title: "从系统建设到经营闭环",
      description: "判断哪些位置需要插图。",
      opening: ["这是开场。", "这是背景。"],
      sections: [
        {
          heading: "背景说明",
          paragraphs: ["团队需要先建立共同认识。"],
          bullets: [],
        },
        {
          heading: "需求到验收的实施流程",
          paragraphs: [
            "先确认需求，再建立基线，然后按阶段验收，最后形成反馈闭环。",
          ],
          bullets: ["确认需求", "建立基线", "阶段验收"],
        },
        {
          heading: "方案差异与取舍",
          paragraphs: ["标准产品与定制开发在周期、成本和适配度上存在差异。"],
          bullets: ["周期", "成本", "适配度"],
        },
      ],
      observation: "视觉化应服务理解。",
      conclusion: "不是每一章都需要配图。",
      cta: "优先画清复杂关系。",
      evidenceIds: [],
    });
    const plans = planArticleIllustrations(article);
    expect(plans).toHaveLength(6);
    expect(plans.map((plan) => plan.sectionIndex)).toEqual(
      expect.arrayContaining([1, 2]),
    );
    expect(new Set(plans.map((plan) => plan.visualIntent)).size).toBe(6);
    expect(plans).toContainEqual(
      expect.objectContaining({ sectionIndex: 1, visualIntent: "cycle" }),
    );
    expect(plans).toContainEqual(
      expect.objectContaining({ sectionIndex: 2, visualIntent: "comparison" }),
    );
  });
});
