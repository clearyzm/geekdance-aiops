import type {
  Channel,
  ContentJobRequest,
  CoreArticle,
  EvidenceItem,
  ResearchAttachment,
} from "@geekdance/shared";
import type { MaterialCandidate } from "./material-selector.js";

export function mockResearch(
  request: ContentJobRequest,
  attachments: ResearchAttachment[] = [],
): EvidenceItem[] {
  return [
    {
      id: "mock-evidence-1",
      title: "本地 Mock 证据：仅用于流程验收",
      url: "https://example.com/geekdance-mock-evidence",
      sourceType: "mock",
      claims: [`测试流程围绕“${request.topic}”生成，不得用于真实发布`],
      accessedAt: new Date().toISOString(),
    },
    ...attachments.map((attachment, index) => ({
      id: `mock-attachment-${index + 1}`,
      title: `用户附件：${attachment.name}`,
      url: `https://aiops.geekdance.cn/internal/attachments/${attachment.id}`,
      sourceType: "user_attachment" as const,
      claims: [
        attachment.extractedText
          ? `本地验收已成功解析附件“${attachment.name}”并将文本提供给内容流程`
          : `本地验收已成功识别图片附件“${attachment.name}”并进入视觉资料流程`,
      ],
      accessedAt: new Date().toISOString(),
    })),
  ];
}

export function mockWrite(
  request: ContentJobRequest,
  channel: Channel = "official_site",
): CoreArticle {
  const topic = request.topic.trim();
  const title =
    request.title?.trim() ||
    (channel === "official_site"
      ? `${topic.slice(0, 18)}，企业该先看清什么？`
      : `${topic.slice(0, 18)}：先别急着追热点`);
  return {
    title,
    description: `围绕${topic}，企业真正需要判断的不是概念是否热门，而是它能否进入日常流程、连接现有系统，并在可控范围内解决具体业务问题。`,
    opening: [
      channel === "official_site"
        ? `最近，围绕${topic}的讨论明显增多。很多团队已经开始评估，它是否值得进入下一阶段的产品和运营计划。`
        : `打开行业群和公众号，${topic}正在高频出现。对业务负责人来说，更重要的问题不是跟不跟，而是它能不能进入一项真实工作。`,
      `表面上看，这像是一次工具升级。放到真实业务里，问题会更具体：哪些工作可以交给 AI，哪些环节必须由人确认，现有数据和系统是否支持。`,
      `极客跳动更关注落地条件。一个新能力只有进入客户咨询、内容运营、销售跟进或内部协作，才可能形成持续价值。`,
    ],
    sections: [
      {
        heading: "先从业务问题出发，而不是先选模型",
        paragraphs: [
          `企业可以先把${topic}对应到一项高频工作，明确谁在做、耗时在哪里、结果由谁检查。问题足够清楚，技术选择才有依据。`,
        ],
        bullets: [
          "找出重复出现、规则相对清楚的工作",
          "确认输入资料是否稳定、输出结果由谁审核",
          "把效果写成可观察的业务指标",
        ],
      },
      {
        heading: "数据和流程决定工具能不能长期使用",
        paragraphs: [
          "AI 可以生成内容或建议，但它不知道企业内部哪些资料可信、哪些信息只能给特定成员查看。资料结构、权限边界和流程节点需要先整理。",
        ],
        bullets: [
          "资料是否有明确版本和负责人",
          "系统之间是否能安全传递必要信息",
          "异常情况是否会回到人工处理",
        ],
      },
      {
        heading: "用小范围验证代替一次性大改造",
        paragraphs: [
          "更稳妥的做法，是先选择一个团队和一条流程，保留人工审核，连续记录结果。极客跳动可以把这一验证范围落成 MVP，验证有效后再扩大范围，并补充权限、日志和异常处理。",
        ],
        bullets: [
          "先跑通一个可重复场景",
          "记录质量、耗时和人工修改量",
          "确认稳定后再连接更多系统",
        ],
      },
      {
        heading: "企业现在可以检查的四个条件",
        paragraphs: [
          "如果业务目标、资料、接口和审核责任都比较清楚，项目通常更容易进入可用状态。任何一项仍然模糊，都应该先补齐基础工作。",
        ],
        bullets: [
          "目标是否具体",
          "资料是否可靠",
          "系统是否可连接",
          "责任是否清楚",
        ],
      },
    ],
    observation:
      "AI 项目的难点通常不在第一次演示，而在于能否稳定进入日常工作，并让团队知道何时可以自动执行、何时必须停下来检查。",
    conclusion: `围绕${topic}，企业不必追求一步到位。先把一个具体问题、所需资料和审核边界说明白，往往比堆叠更多功能更有效。`,
    cta:
      channel === "official_site"
        ? "如果需要把想法落成小程序、APP、后台系统或 AI 工作流，极客跳动可以协助梳理需求、设计系统并完成开发交付。"
        : "需要进一步判断业务场景、系统接口和实施边界时，可以从一条可验证的流程开始梳理。",
    evidenceIds: ["mock-evidence-1"],
  };
}

export function mockMaterials(request: ContentJobRequest): MaterialCandidate[] {
  const tag = request.secondaryTags?.[0] || request.primaryTag || "AI";
  return [0, 1, 2].map((index) => ({
    id: `mock-material-${index + 1}`,
    title: `${tag} 企业内容配图 ${index + 1}`,
    url: `https://mock.geekhome.local/material-${index + 1}.jpg`,
    primaryTag: request.primaryTag || tag,
    secondaryTags: [tag],
    tags: ["官网", "公众号", "品牌", "科技"],
    description: `${request.topic} 的本地流程测试素材`,
    usageCount: index,
    authorized: true,
    containsPerson: false,
  }));
}
