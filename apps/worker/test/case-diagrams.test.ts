import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  articleSectionDiagramLabels,
  caseCoverHeroVariant,
  caseCoverTitleLines,
  renderArticleSectionDiagram,
  renderCaseDiagram,
  replaceCoverTextInRegion,
} from "../src/case-diagrams.js";

describe("case diagram renderer", () => {
  it("只在选中区域重绘准确封面文字", async () => {
    const source = await sharp({
      create: {
        width: 1200,
        height: 1600,
        channels: 4,
        background: "#19191d",
      },
    })
      .png()
      .toBuffer();
    const output = await replaceCoverTextInRegion(
      new Uint8Array(source),
      "宠物服务 APP",
      { x: 0.08, y: 0.12, width: 0.58, height: 0.16 },
    );
    expect(await sharp(output).metadata()).toMatchObject({
      width: 1200,
      height: 1600,
      format: "jpeg",
      chromaSubsampling: "4:4:4",
    });
  });

  it("keeps ASCII product terms intact when wrapping a Chinese cover title", () => {
    const lines = caseCoverTitleLines(
      "不做海量房源库：宅邸青年 AI 房产顾问平台方案拆解",
    );
    expect(lines).toEqual(["宅邸青年 AI", "房产顾问平台", "方案拆解"]);
  });

  it("selects a concrete real-estate hero for a property case", () => {
    expect(caseCoverHeroVariant("宅邸青年 AI 房产顾问平台")).toBe(
      "real_estate",
    );
  });

  it("renders a branded 1620x2160 project diagram", async () => {
    const brandRoot = new URL("../../web/public/brand/", import.meta.url);
    const rendered = await renderCaseDiagram(
      {
        diagramType: "function",
        projectName: "宅邸青年",
        title: "宅邸青年项目功能全览图",
        subtitle: "AI 房产顾问服务数字化平台方案",
        sequence: ["需求沟通", "房源匹配", "顾问跟进", "服务闭环"],
        modules: Array.from({ length: 7 }, (_, index) => ({
          title: `功能模块 ${index + 1}`,
          items: ["项目材料确认能力", "业务流程对应功能"],
          evidenceIds: ["attachment-1"],
        })),
        supports: ["权限管理", "数据安全", "运营后台"],
        sourceAttachmentIds: ["44444444-4444-4444-8444-444444444444"],
      },
      {
        logoPath: fileURLToPath(new URL("geekdance-logo.png", brandRoot)),
        mascotPath: fileURLToPath(new URL("geekdance-mascot.png", brandRoot)),
      },
    );
    const metadata = await sharp(rendered.png).metadata();
    expect(metadata).toMatchObject({ width: 1620, height: 2160 });
    expect(rendered.svg.toString()).toContain("GeekDance 极客跳动");
    expect(rendered.svg.toString()).toContain("宅邸青年项目功能全览图");
  });

  it("renders article chapters as exact-text structure diagrams", async () => {
    const section = {
      heading: "AI 如何筛选推荐品牌",
      paragraphs: ["系统先读取用户需求，再按照规则完成候选筛选。"],
      bullets: ["距离", "价格", "库存", "时间", "规则"],
    };
    expect(articleSectionDiagramLabels(section)).toEqual([
      "距离",
      "价格",
      "库存",
      "时间",
    ]);
    const rendered = await renderArticleSectionDiagram(
      {
        title: "小程序还没打开，AI 已经开始筛选品牌",
        description: "AI 根据用户需求提前完成筛选。",
        opening: ["用户提出需求。", "系统开始处理。"],
        sections: [section, section, section],
        observation: "推荐必须可解释。",
        conclusion: "结构清晰才能建立信任。",
        cta: "先梳理筛选规则。",
        evidenceIds: [],
      },
      section,
      1,
      "4:3",
      Buffer.from("approved-logo"),
    );
    const metadata = await sharp(rendered.png).metadata();
    const svg = rendered.svg.toString();

    expect(metadata).toMatchObject({ width: 1200, height: 900 });
    expect(svg).toContain('data-diagram-type="article-section"');
    expect(svg).toContain('data-diagram-layout="process"');
    expect(svg).toContain('data-gd-company-logo="true"');
    expect(svg).toContain('data-gd-logo-position="top-right"');
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain("AI 如何筛选推荐品牌");
    expect(svg).toContain("距离");
    expect(svg).toContain("库存");
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('font-family="Alibaba PuHuiTi 2.0"');
    expect(svg).toContain('letter-spacing="0.03em"');
    expect(svg).not.toContain("PingFang SC");
    expect(svg).not.toMatch(/font-weight="8\d\d"/u);
  });

  it("chooses visual grammar from content instead of chapter order", async () => {
    const sections = [
      {
        heading: "实施流程",
        paragraphs: ["先确认需求，然后开发，最后验收。"],
        bullets: ["需求", "开发", "验收"],
      },
      {
        heading: "方案差异",
        paragraphs: ["两种方案在成本和周期上存在差异。"],
        bullets: ["标准产品", "定制开发", "业务适配"],
      },
      {
        heading: "指标趋势",
        paragraphs: ["交付周期逐步降低，转化率持续提升。"],
        bullets: ["周期降低", "转化提升", "变化趋势"],
      },
      {
        heading: "协同关系",
        paragraphs: ["销售、交付和财务相互依赖并形成协同。"],
        bullets: ["销售", "交付", "财务"],
      },
    ];
    const article = {
      title: "四种章节结构验证",
      description: "验证流程、分层、对比和检查清单。",
      opening: ["开始验证。"],
      sections,
      observation: "每章结构应不同。",
      conclusion: "结构服务于内容。",
      cta: "检查结构。",
      evidenceIds: [],
    };
    const layouts = await Promise.all(
      sections.map(async (section, index) => {
        const rendered = await renderArticleSectionDiagram(
          article,
          section,
          index,
          "4:3",
          Buffer.from("approved-logo"),
        );
        return rendered.svg
          .toString()
          .match(/data-diagram-layout="([^"]+)"/u)?.[1];
      }),
    );
    expect(layouts).toEqual([
      "process",
      "comparison",
      "funnel",
      "relationship",
    ]);
  });

  it("supports distinctly different content-driven visual families", async () => {
    const cases = [
      ["产品演进时间轴", "过去、现在与未来的关键里程碑。", "timeline"],
      ["三阶段实施路线图", "短期、中期、长期逐步落地。", "roadmap"],
      ["客户转化漏斗", "从触达到成交，再关注留存。", "funnel"],
      ["平台技术架构", "应用层、服务层和数据层协同。", "architecture"],
      ["业务生态角色", "平台方连接供给方、需求方和合作伙伴。", "ecosystem"],
      ["上线检查清单", "关键动作、原则与注意事项。", "checklist"],
    ] as const;
    for (const [heading, paragraph, expected] of cases) {
      const section = {
        heading,
        paragraphs: [paragraph],
        bullets: ["需求梳理", "方案设计", "开发交付", "持续运营"],
      };
      const rendered = await renderArticleSectionDiagram(
        {
          title: "多框架自动选择",
          description: "验证不同内容使用不同视觉语法。",
          opening: ["从内容出发。"],
          sections: [section, section, section],
          observation: "框架服务于理解。",
          conclusion: "不同内容不应套同一个模板。",
          cta: "选择合适的表达方式。",
          evidenceIds: [],
        },
        section,
        0,
        "4:3",
        Buffer.from("approved-logo"),
      );
      expect(rendered.svg.toString()).toContain(
        `data-diagram-layout="${expected}"`,
      );
    }
  });

  it("高亮标题中的业务关键词，而不是固定标红末尾", async () => {
    const section = {
      heading: "企业开发宠物市场 APP，先验证用户需求",
      paragraphs: ["先梳理养宠人群、服务方和交易流程。"],
      bullets: ["用户", "服务", "交易"],
    };
    const rendered = await renderArticleSectionDiagram(
      {
        title: "宠物服务 APP 的 MVP 验证路径",
        description: "先验证需求再进入开发。",
        opening: ["从真实需求出发。"],
        sections: [section, section, section],
        observation: "不用一次性投入全部功能。",
        conclusion: "小范围验证后再分阶段开发。",
        cta: "先完成 MVP 范围梳理。",
        evidenceIds: [],
      },
      section,
      0,
      "4:3",
      Buffer.from("approved-logo"),
    );
    const svg = rendered.svg.toString();
    expect(svg).toContain('data-highlight-keyword="宠物市场"');
    expect(svg).toContain('<tspan fill="#E60012">宠物市场</tspan>');
    expect(svg).not.toContain('<tspan fill="#E60012">用户需求</tspan>');
  });

  it("wraps production-length chapter labels without cutting card copy", async () => {
    const section = {
      heading: "权限控制要发生在检索阶段",
      paragraphs: [
        "企业还要重视权限同步。原系统已经撤销访问资格，并不代表搜索索引中的权限信息会自动保持一致。",
      ],
      bullets: [
        "明确用户身份从哪里取得，以及身份信息如何传入检索服务",
        "让每份文档携带可判断的权限信息，并与原业务系统保持同步",
        "定期测试调岗、离职、跨部门协作等情况下的访问结果",
      ],
    };
    const rendered = await renderArticleSectionDiagram(
      {
        title: "给AI答案留凭据：权限、引用与审计记录",
        description: "测试长文本换行。",
        opening: ["测试。"],
        sections: [section],
        observation: "测试。",
        conclusion: "测试。",
        cta: "测试。",
        evidenceIds: [],
      },
      section,
      0,
      "4:3",
    );
    const svg = rendered.svg.toString();
    expect(svg).toContain("明确用户身份从哪里");
    expect(svg).toContain("取得，以及身份信息");
    expect(svg).toContain("传入检索服务");
    expect(svg).toContain("定期测试调岗、离职");
    expect(svg).toContain("、跨部门协作等情况");
  });

  it("keeps a long chapter title complete and inside the header safe area", async () => {
    const heading =
      "企业接入生成式人工智能前需要先建立权限边界、证据追踪与持续验收机制";
    const section = {
      heading,
      paragraphs: ["先明确权限，再建立证据链，最后持续验收。"],
      bullets: ["明确权限边界", "建立证据追踪", "持续执行验收"],
    };
    const rendered = await renderArticleSectionDiagram(
      {
        title: "企业人工智能治理",
        description: "测试长标题自适应。",
        opening: ["测试。"],
        sections: [section],
        observation: "测试。",
        conclusion: "测试。",
        cta: "测试。",
        evidenceIds: [],
      },
      section,
      0,
      "4:3",
      Buffer.from("approved-logo"),
    );
    const svg = rendered.svg.toString();
    const visibleTitle = [
      ...svg.matchAll(/<text data-exact-title="[^"]+"[^>]*>(.*?)<\/text>/gu),
    ]
      .map((match) => match[1]!.replace(/<[^>]+>/gu, ""))
      .join("");
    const titleBaselines = [
      ...svg.matchAll(/<text data-exact-title="[^"]+" x="[^"]+" y="([^"]+)"/gu),
    ].map((match) => Number(match[1]));

    expect(visibleTitle).toBe(heading);
    expect(titleBaselines.length).toBeGreaterThan(1);
    expect(Math.max(...titleBaselines)).toBeLessThan(208);
    expect(svg).toContain(`data-exact-copy="明确权限边界"`);
  });
});
