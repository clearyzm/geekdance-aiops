import { createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type {
  ContentJobRequest,
  CoreArticle,
  EvidenceItem,
  ImageJobRequest,
  ResearchAttachment,
} from "@geekdance/shared";
import { imageJobRequestSchema } from "@geekdance/shared";
import type {
  CaseDiagramSpec,
  MaterialCandidate,
} from "@geekdance/content-engine";
import type { OssAssetStore } from "@geekdance/channel-adapters";
import sharp from "sharp";
import {
  GENERATED_IMAGE_FONT_FAMILY,
  renderGeneratedImageSvg,
} from "./svg-renderer.js";
import { detectGeneratedImage, generateAiImages } from "./image-jobs.js";
import {
  articleSectionDiagramLabels,
  classifyArticleSectionVisual,
  overlayCaseCoverTitle,
  renderArticleSectionDiagram,
  renderCaseDiagram,
  renderFallbackCaseCover,
} from "./case-diagrams.js";

type ContentImageOptions = {
  db: pg.Pool;
  createdBy: string;
  contentJobId: string;
  storageDir: string;
  imageServiceUrl: string;
  logoPath: string;
  articleIllustrationLogoPath?: string;
  mascotPath: string;
  publicBaseUrl: string;
  publicSecret: string;
  providerMode: "openrouter" | "openai";
  imageApiKey?: string;
  imageBaseUrl: string;
  model: string;
  allowedResultHosts: string[];
  allowDeterministicFallback?: boolean;
  aiImageGenerator?: typeof generateAiImages;
  assetStore?: OssAssetStore;
  caseDiagramSpecGenerator?: (
    request: ContentJobRequest,
    evidence: EvidenceItem[],
    attachments: ResearchAttachment[],
  ) => Promise<CaseDiagramSpec[]>;
};

const CONTENT_IMAGE_PROVIDER_CONCURRENCY = 3;

const VISUAL_INTENT_DIRECTIONS: Record<
  ReturnType<typeof classifyArticleSectionVisual>,
  string
> = {
  process: "横向或斜向步骤流，节点之间有明确先后方向",
  timeline: "纵向时间轴与交替里程碑，突出前后演进",
  roadmap: "弯曲路径或阶段路标，体现从当前到目标的推进",
  funnel: "由宽到窄的转化漏斗，体现筛选、流失或沉淀",
  comparison: "左右分区的差异对照，视觉重心保持平衡",
  trend: "折线、阶梯或面积变化，突出方向和拐点",
  hierarchy: "由基础到上层的层级结构，体现支撑关系",
  architecture: "多层系统架构或模块连接，突出上下游依赖",
  cycle: "环形闭环与反馈箭头，阅读路径首尾相接",
  matrix: "二维象限或坐标分布，突出优先级与定位",
  ecosystem: "中心平台与多角色环绕，体现供需和协同",
  checklist: "非卡片式纵向行动清单，以序号和检查标记引导",
  relationship: "中心节点与分支网络，突出因果、连接和影响",
  concept: "一个核心概念与少量辅助对象，使用具象视觉隐喻",
};

function publicAssetUrl(options: ContentImageOptions, assetId: string) {
  const signature = createHmac("sha256", options.publicSecret)
    .update(assetId)
    .digest("hex");
  return `${options.publicBaseUrl.replace(/\/$/, "")}/${assetId}/${signature}`;
}

export function attachmentImageSources(attachments: ResearchAttachment[]) {
  const sources: Array<{ bytes: Uint8Array; mime: string }> = [];
  for (const attachment of attachments) {
    if (!attachment.dataUrl) continue;
    const matched = attachment.dataUrl.match(
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u,
    );
    if (!matched) continue;
    const bytes = Buffer.from(matched[2]!, "base64");
    if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) continue;
    sources.push({ bytes: new Uint8Array(bytes), mime: matched[1]! });
    if (sources.length === 4) break;
  }
  return sources;
}

export function buildContentImagePrompts(
  request: ContentJobRequest,
  article: CoreArticle,
) {
  const ratio = "4:3" as const;
  const plans = planArticleIllustrations(article);
  const common = `你正在为极客跳动的中文企业文章设计一张辅助理解型信息插图的无文字视觉底图。\n文章主题：${article.title}\n文章摘要：${article.description}\n固定视觉：4:3 横版纯白背景，黑色和深灰为主体，品牌红 #DA251C 只作克制强调。画面现代、专业、简洁，但信息不能空泛。\n内容原则：用线性图标、符号、细灰描边、节点、连线、箭头、数据形状和空间关系传递结构、关系、过程、差异、变化或趋势。构图和内容层级参考专业中文企业信息插图，而不是照片或艺术海报。\n文字硬约束：画面中绝对不能出现任何文字、汉字、字母、数字、品牌名、Logo、乱码、伪文字或水印；准确标题、节点标签、序号、结论和官方 Logo 全部由程序后期排版。请只生成无文字图形底图。\n排版约束：为后期文字留下清楚的逻辑区域，图形集中在画面中部；避免大面积空白，同时不要用装饰填满画面。\n禁止固定套用卡片模板或同一种卡片结构；禁止 PPT/幻灯片外框、大标题加几个框、大段正文、人物、人像、假界面、仿真实景照片、仪表盘、3D 玩具、拟人机器人、蓝色赛博朋克及任何模型生成的 Logo。`;
  const prompts = plans.map((plan, index) => {
    const labels = articleSectionDiagramLabels(plan.section);
    const previousIntents = plans
      .slice(0, index)
      .map((item) => item.visualIntent)
      .join("、");
    return `${common}\n值得视觉化的章节：${plan.section.heading}\n判断依据：${plan.reason}\n本图选定的视觉语法：${VISUAL_INTENT_DIRECTIONS[plan.visualIntent]}。视觉语法由正文信号自动判断，只约束信息关系，不得套用通用卡片模板。\n章节事实：${plan.section.paragraphs.slice(0, 3).join(" ").slice(0, 900)}\n需要用图形表达的语义：${labels.join("｜")}。这些内容仅用于理解，严禁把它们画成文字。\n${previousIntents ? `本篇前图已使用过的表达方向：${previousIntents}。本图必须采用明显不同的空间结构、阅读路径和视觉重心，不能复刻前图构图。` : "这是本篇第一张图，请选择最符合当前内容的视觉结构，不要预设模板。"}\n请围绕本段最重要的${plan.reason}组织视觉关系，不增加正文中不存在的结论。再次确认：最终底图不得含任何可读或不可读文字。`;
  });
  return { ratio, prompts, plans } as const;
}

export type ArticleIllustrationPlan = {
  sectionIndex: number;
  section: CoreArticle["sections"][number];
  visualIntent: ReturnType<typeof classifyArticleSectionVisual>;
  score: number;
  reason: string;
};

export function planArticleIllustrations(
  article: CoreArticle,
): ArticleIllustrationPlan[] {
  const scoreSection = (
    section: CoreArticle["sections"][number],
    sectionIndex: number,
    preferredIntent?: ArticleIllustrationPlan["visualIntent"],
  ) => {
    const body = `${section.heading} ${section.paragraphs.join(" ")} ${section.bullets.join(" ")}`;
    const signals = [
      {
        pattern: /转化|漏斗|获客|触达|成交|留存|流失|转化率/u,
        label: "转化与留存路径",
        weight: 4,
      },
      {
        pattern: /过去|现在|未来|演进|沿革|里程碑|时间轴|历程/u,
        label: "时间演进",
        weight: 4,
      },
      {
        pattern: /路线图|短期|中期|长期|规划|落地路径|实施路径/u,
        label: "实施路线图",
        weight: 4,
      },
      {
        pattern:
          /技术架构|系统架构|数据层|服务层|应用层|前端|后端|模块|子系统/u,
        label: "系统架构",
        weight: 4,
      },
      {
        pattern: /生态|参与方|角色|供给|需求方|平台方|合作伙伴/u,
        label: "业务生态关系",
        weight: 4,
      },
      {
        pattern: /清单|原则|建议|注意事项|关键动作|检查项/u,
        label: "行动清单",
        weight: 4,
      },
      {
        pattern: /先|再|随后|然后|最后|步骤|阶段|流程|流转|从.+到/u,
        label: "过程与阶段",
        weight: 3,
      },
      {
        pattern: /对比|相比|区别|差异|取舍|而不是|优缺点|高于|低于/u,
        label: "差异与取舍",
        weight: 3,
      },
      {
        pattern:
          /增长|下降|趋势|变化|提升|降低|同比|环比|\d+(?:\.\d+)?\s*[%％]/u,
        label: "变化或数据趋势",
        weight: 3,
      },
      {
        pattern: /依赖|影响|关联|协同|连接|关系|导致|因此|驱动/u,
        label: "关系与因果",
        weight: 3,
      },
      {
        pattern: /层级|底层|上层|支撑|组成|结构|体系|分为/u,
        label: "结构与层级",
        weight: 3,
      },
      { pattern: /闭环|循环|持续迭代|反馈/u, label: "循环与反馈", weight: 3 },
      {
        pattern: /维度|优先级|象限|高低|紧急|重要/u,
        label: "多维判断",
        weight: 3,
      },
    ].filter((signal) => signal.pattern.test(body));
    const score =
      signals.reduce((sum, signal) => sum + signal.weight, 0) +
      Math.min(3, section.bullets.length) +
      (section.paragraphs.length > 1 ? 1 : 0);
    return {
      sectionIndex,
      section,
      visualIntent: preferredIntent ?? classifyArticleSectionVisual(section),
      score,
      reason:
        signals
          .map((signal) => signal.label)
          .slice(0, 2)
          .join("、") ||
        (section.bullets.length >= 3 ? "多个并列核心要点" : "核心概念关系"),
    };
  };
  const actual = article.sections.map((section, sectionIndex) =>
    scoreSection(section, sectionIndex),
  );
  const syntheticSections: Array<{
    section: CoreArticle["sections"][number];
    intent: ArticleIllustrationPlan["visualIntent"];
    reason: string;
  }> = [
    {
      section: {
        heading: "全文核心结构",
        paragraphs: [article.description],
        bullets: article.sections.map((section) => section.heading),
      },
      intent: "architecture" as const,
      reason: "全文模块与结构",
    },
    {
      section: {
        heading: "问题背景与关键变化",
        paragraphs: article.opening,
        bullets: article.opening,
      },
      intent: "timeline" as const,
      reason: "背景与变化进程",
    },
    {
      section: {
        heading: "核心判断与行动建议",
        paragraphs: [article.observation, article.conclusion, article.cta],
        bullets: [article.observation, article.conclusion, article.cta],
      },
      intent: "roadmap" as const,
      reason: "判断、结论与实施路线",
    },
  ].map((item) => ({
    ...item,
    section: {
      ...item.section,
      paragraphs: item.section.paragraphs.filter(Boolean),
      bullets: item.section.bullets.filter(Boolean),
    },
  }));
  const synthetic = syntheticSections.map((item, index) => ({
    ...scoreSection(item.section, article.sections.length + index, item.intent),
    score: 5 - index * 0.1,
    reason: item.reason,
  }));
  const ranked = [
    ...actual.filter((item) => item.score >= 4),
    ...synthetic,
    ...actual.filter((item) => item.score < 4),
  ].filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) => candidate.sectionIndex === item.sectionIndex,
      ) === index,
  );
  const allIntents: ArticleIllustrationPlan["visualIntent"][] = [
    "process",
    "timeline",
    "roadmap",
    "funnel",
    "comparison",
    "relationship",
    "hierarchy",
    "architecture",
    "matrix",
    "ecosystem",
    "checklist",
    "concept",
    "cycle",
    "trend",
  ];
  const usedIntents = new Set<ArticleIllustrationPlan["visualIntent"]>();
  return ranked.slice(0, 6).map((plan) => {
    const preferences = [
      plan.visualIntent,
      ...(plan.section.bullets.length >= 3
        ? (["hierarchy", "matrix"] as const)
        : (["concept", "relationship"] as const)),
      ...allIntents,
    ];
    const visualIntent = preferences.find((intent) => !usedIntents.has(intent));
    if (!visualIntent) throw new Error("ARTICLE_ILLUSTRATION_LAYOUT_EXHAUSTED");
    usedIntents.add(visualIntent);
    return { ...plan, visualIntent };
  });
}

export async function finalizeArticleSectionDiagram(
  image: Uint8Array,
  logo: Uint8Array,
  ratio: "4:3",
  heading = "",
) {
  void ratio;
  const size = { width: 1200, height: 900 };
  const safeHeading = escapeSvgText(heading.trim().slice(0, 44));
  const titleLines = splitTitle(heading.trim(), 22).slice(0, 2);
  const header = await renderGeneratedImageSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.76" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient></defs>
    <rect x="0" y="0" width="1200" height="215" fill="url(#fade)"/>
    <rect x="68" y="54" width="40" height="6" rx="3" fill="#DA251C"/>
    <text x="68" y="${titleLines.length > 1 ? 113 : 137}" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="${titleLines.length > 1 ? 39 : 45}" font-weight="700" fill="#17171A">${titleLines.map((line, index) => `<tspan x="68" dy="${index ? 50 : 0}">${escapeSvgText(line)}</tspan>`).join("") || safeHeading}</text>
    <path d="M68 196H1132" stroke="#ECEDEF" stroke-width="2"/>
  </svg>`,
  );
  const preparedLogo = await sharp(Buffer.from(logo))
    .resize({ width: 190, height: 76, fit: "contain" })
    .png()
    .toBuffer();
  return sharp(Buffer.from(image))
    .resize(size.width, size.height, { fit: "cover" })
    .composite([
      { input: header, left: 0, top: 0 },
      { input: preparedLogo, left: 942, top: 46 },
    ])
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

function escapeSvgText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function splitTitle(value: string, width: number) {
  if (!value) return [];
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += width)
    lines.push(value.slice(offset, offset + width));
  return lines;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await task(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function xiaohongshuCoverPrompt(article: CoreArticle) {
  return `为极客跳动文章“${article.title}”生成一张独立的小红书 3:4 竖版封面底图。文章摘要：${article.description}。结合文章核心观点：${article.sections
    .slice(0, 3)
    .map((section) => section.heading)
    .join(
      "、",
    )}。画面必须直接呈现文章主题对应的真实对象、业务场景或清晰概念关系，构图灵动、现代、专业，缩略图中主体明确；官网和公众号封面不会复用本图。使用自然真实的商业编辑视觉，主色克制，允许少量极客跳动红 #DA251C 强调。下方约 35% 保持简洁、对比稳定，供程序叠加准确标题与摘要；右上角预留官方 Logo 区域。严禁生成任何文字、汉字、字母、数字、Logo、乱码、水印、通用机器人、发光球体、蓝色赛博朋克或无具体内容的抽象背景。`;
}

async function overlayXiaohongshuCoverCopy(
  source: Uint8Array,
  article: CoreArticle,
  logo: Uint8Array,
) {
  const width = 1200;
  const height = 1600;
  const titleLines = splitTitle(article.title.trim(), 15).slice(0, 3);
  const bodyLines = splitTitle(article.description.trim(), 24).slice(0, 2);
  const overlay = await renderGeneratedImageSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="copyFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="0.28" stop-color="#FFFFFF" stop-opacity="0.9"/><stop offset="0.48" stop-color="#FFFFFF" stop-opacity="0.98"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient></defs>
    <rect x="0" y="930" width="1200" height="670" fill="url(#copyFade)"/>
    <rect x="72" y="1070" width="52" height="8" rx="4" fill="#DA251C"/>
    <text x="72" y="1160" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="64" font-weight="700" fill="#17171A">${titleLines
      .map(
        (line, index) =>
          `<tspan x="72" dy="${index ? 82 : 0}">${escapeSvgText(line)}</tspan>`,
      )
      .join("")}</text>
    <text x="72" y="${1418 + Math.max(0, titleLines.length - 2) * 24}" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="30" font-weight="400" fill="#555860">${bodyLines
      .map(
        (line, index) =>
          `<tspan x="72" dy="${index ? 46 : 0}">${escapeSvgText(line)}</tspan>`,
      )
      .join("")}</text>
  </svg>`,
  );
  const preparedLogo = await sharp(Buffer.from(logo))
    .resize({ width: 230, height: 92, fit: "contain" })
    .png()
    .toBuffer();
  return new Uint8Array(
    await sharp(Buffer.from(source))
      .resize(width, height, { fit: "cover", position: "attention" })
      .composite([
        { input: overlay, left: 0, top: 0 },
        { input: preparedLogo, left: 898, top: 54 },
      ])
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
      .toBuffer(),
  );
}

async function generateXiaohongshuCoverVisual(
  options: ContentImageOptions,
  request: ContentJobRequest,
  article: CoreArticle,
  logo: Uint8Array,
) {
  const prompt = xiaohongshuCoverPrompt(article);
  try {
    if (options.providerMode !== "openai" || options.model !== "gpt-image-2")
      throw new Error("XIAOHONGSHU_COVER_IMAGE_2_REQUIRED");
    const generated = await (options.aiImageGenerator ?? generateAiImages)(
      {
        providerMode: "openai",
        imageApiKey: options.imageApiKey,
        imageBaseUrl: options.imageBaseUrl,
        model: "gpt-image-2",
        allowedResultHosts: options.allowedResultHosts,
        promptOverride: prompt,
      },
      imageJobRequestSchema.parse({
        operationId: request.operationId,
        operation: "generate",
        prompt: article.title,
        sourceAssetIds: [],
        ratio: "3:4",
        count: 1,
        quality: "high",
        rightsConfirmed: true,
      }),
      [],
    );
    if (!generated.outputs[0]) throw new Error("XIAOHONGSHU_COVER_INCOMPLETE");
    return {
      bytes: await overlayXiaohongshuCoverCopy(
        generated.outputs[0],
        article,
        logo,
      ),
      prompt,
      costCents: generated.costCents,
    };
  } catch (error) {
    if (!options.allowDeterministicFallback) throw error;
    const fallback = new Uint8Array(
      await sharp({
        create: {
          width: 1200,
          height: 1600,
          channels: 3,
          background: "#f4f4f3",
        },
      })
        .jpeg({ quality: 94 })
        .toBuffer(),
    );
    return {
      bytes: await overlayXiaohongshuCoverCopy(fallback, article, logo),
      prompt,
      costCents: 0,
    };
  }
}

export async function generateContentImages(
  options: ContentImageOptions,
  request: ContentJobRequest,
  article: CoreArticle,
  evidence: EvidenceItem[] = [],
  attachments: ResearchAttachment[] = [],
  onProgress?: (completed: number, total: number) => Promise<void> | void,
): Promise<MaterialCandidate[]> {
  if (request.contentType === "case")
    return generateCaseContentImages(
      options,
      request,
      article,
      evidence,
      attachments,
      onProgress,
    );
  const {
    ratio,
    prompts: briefs,
    plans,
  } = buildContentImagePrompts(request, article);
  const logo = new Uint8Array(
    await readFile(options.articleIllustrationLogoPath ?? options.logoPath),
  );
  const needsXiaohongshuCover = request.targets.includes("xiaohongshu");
  const expectedTotal = briefs.length + (needsXiaohongshuCover ? 1 : 0);
  let completed = 0;
  const reportCompleted = async () => {
    completed += 1;
    await onProgress?.(completed, expectedTotal);
  };
  const xiaohongshuCoverPromise = needsXiaohongshuCover
    ? generateXiaohongshuCoverVisual(options, request, article, logo).finally(
        reportCompleted,
      )
    : Promise.resolve(undefined);
  const generatedVisuals = await mapWithConcurrency(
    briefs,
    CONTENT_IMAGE_PROVIDER_CONCURRENCY,
    async (prompt, briefIndex) => {
      const plan = plans[briefIndex];
      if (!plan) throw new Error("CONTENT_ILLUSTRATION_PLAN_MISSING");
      try {
        if (
          options.providerMode !== "openai" ||
          options.model !== "gpt-image-2"
        )
          throw new Error("CONTENT_ILLUSTRATION_IMAGE_2_REQUIRED");
        const input = imageJobRequestSchema.parse({
          operationId: request.operationId,
          operation: "generate",
          prompt: plan.section.heading,
          sourceAssetIds: [],
          ratio,
          count: 1,
          quality: "high",
          rightsConfirmed: true,
        }) satisfies ImageJobRequest;
        const generated = await (options.aiImageGenerator ?? generateAiImages)(
          {
            providerMode: "openai",
            imageApiKey: options.imageApiKey,
            imageBaseUrl: options.imageBaseUrl,
            model: "gpt-image-2",
            allowedResultHosts: options.allowedResultHosts,
            promptOverride: prompt,
          },
          input,
          [],
        );
        if (!generated.outputs[0])
          throw new Error("CONTENT_ILLUSTRATION_INCOMPLETE");
        const rendered = await renderArticleSectionDiagram(
          article,
          plan.section,
          plan.sectionIndex,
          ratio,
          logo,
          plan.visualIntent,
          generated.outputs[0],
        );
        return {
          bytes: rendered.png,
          prompt,
          mode: "image_2_exact_text_overlay" as const,
          costCents: generated.costCents,
        };
      } catch (error) {
        if (!options.allowDeterministicFallback) throw error;
        const rendered = await renderArticleSectionDiagram(
          article,
          plan.section,
          plan.sectionIndex,
          ratio,
          logo,
          plan.visualIntent,
        );
        return {
          bytes: rendered.png,
          prompt,
          mode: "deterministic_fallback" as const,
          costCents: 0,
        };
      } finally {
        await reportCompleted();
      }
    },
  );

  const xiaohongshuCover = await xiaohongshuCoverPromise;

  const costCents =
    generatedVisuals.reduce((sum, visual) => sum + visual.costCents, 0) +
    (xiaohongshuCover?.costCents ?? 0);

  const candidates: MaterialCandidate[] = [];
  for (const [index, visual] of generatedVisuals.entries()) {
    const finalBytes = new Uint8Array(
      await sharp(Buffer.from(visual.bytes))
        .resize(1200, 900, { fit: "cover" })
        .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
        .toBuffer(),
    );
    const assetId = randomUUID();
    const format = detectGeneratedImage(finalBytes);
    const storageKey = `${assetId}.${format.extension}`;
    await writeFile(join(options.storageDir, storageKey), finalBytes, {
      mode: 0o644,
      flag: "wx",
    });
    await options.assetStore?.put(storageKey, finalBytes, format.mime);
    await options.db.query(
      `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
       VALUES ($1, $2, $3, 'image', 'ready', $4, $5, $6::jsonb)`,
      [
        assetId,
        options.createdBy,
        visual.mode === "image_2_exact_text_overlay"
          ? "openai"
          : "case_diagram",
        storageKey,
        format.mime,
        JSON.stringify({
          contentJobId: options.contentJobId,
          operationId: request.operationId,
          model: options.model,
          prompt: visual.prompt,
          generationMode: visual.mode,
          textRendering: "deterministic_article_source",
          fontFamily: "Alibaba PuHuiTi 2.0",
          fontWeights: [400, 700],
          visualFrameworkVersion: "content-driven-v2",
          generatedTextureSanitized:
            visual.mode === "image_2_exact_text_overlay",
          provider:
            visual.mode === "image_2_exact_text_overlay"
              ? "openai"
              : "deterministic",
          diagramSkill:
            visual.mode === "deterministic_fallback"
              ? "gd-biz-chart@1.0.0"
              : undefined,
          diagramLabels: articleSectionDiagramLabels(plans[index]!.section),
          costCents,
          role: "inline",
          ossBacked: Boolean(options.assetStore),
          chapterHeading: plans[index]?.section.heading ?? null,
          chapterIndex: plans[index]?.sectionIndex ?? null,
          visualIntent: plans[index]?.visualIntent ?? null,
          illustrationReason: plans[index]?.reason ?? null,
        }),
      ],
    );
    await options.db.query(
      "INSERT INTO asset_blobs (asset_id, bytes) VALUES ($1, $2) ON CONFLICT (asset_id) DO UPDATE SET bytes = EXCLUDED.bytes",
      [assetId, Buffer.from(finalBytes)],
    );
    candidates.push({
      id: assetId,
      title: `辅助理解图：${plans[index]?.section.heading ?? `第 ${index + 1} 处`}`,
      url: publicAssetUrl(options, assetId),
      primaryTag: request.primaryTag,
      secondaryTags: request.secondaryTags ?? [],
      tags: ["内容驱动", "极客跳动", "辅助理解型插图", "含准确文字"],
      description: `${plans[index]?.section.heading ?? "文章内容"}的${plans[index]?.reason ?? "辅助理解"}插图`,
      usageCount: 0,
      authorized: true,
      containsPerson: false,
    });
  }
  if (xiaohongshuCover) {
    const assetId = randomUUID();
    const storageKey = `${assetId}.jpg`;
    await writeFile(
      join(options.storageDir, storageKey),
      xiaohongshuCover.bytes,
      { mode: 0o644, flag: "wx" },
    );
    await options.assetStore?.put(
      storageKey,
      xiaohongshuCover.bytes,
      "image/jpeg",
    );
    await options.db.query(
      `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
       VALUES ($1, $2, 'openai', 'image', 'ready', $3, 'image/jpeg', $4::jsonb)`,
      [
        assetId,
        options.createdBy,
        storageKey,
        JSON.stringify({
          contentJobId: options.contentJobId,
          operationId: request.operationId,
          model: "gpt-image-2",
          provider: "openai",
          prompt: xiaohongshuCover.prompt,
          costCents: xiaohongshuCover.costCents,
          role: "cover",
          targetChannel: "xiaohongshu",
          ratio: "3:4",
          width: 1200,
          height: 1600,
          titleFontWeight: 700,
          bodyFontFamily: "Alibaba PuHuiTi 2.0",
          textRendering: "deterministic_article_source",
          ossBacked: Boolean(options.assetStore),
        }),
      ],
    );
    await options.db.query(
      "INSERT INTO asset_blobs (asset_id, bytes) VALUES ($1, $2) ON CONFLICT (asset_id) DO UPDATE SET bytes = EXCLUDED.bytes",
      [assetId, Buffer.from(xiaohongshuCover.bytes)],
    );
  }
  await options.db.query(
    "UPDATE content_jobs SET image_cost_cents = image_cost_cents + $1 WHERE id = $2",
    [costCents, options.contentJobId],
  );
  return candidates;
}

async function persistCaseVisual(
  options: ContentImageOptions,
  request: ContentJobRequest,
  bytes: Uint8Array,
  visualType: string,
  title: string,
  svg?: Uint8Array,
  generationMetadata: Record<string, unknown> = {},
) {
  const assetId = randomUUID();
  const storageKey = `${assetId}.jpg`;
  await writeFile(join(options.storageDir, storageKey), bytes, {
    mode: 0o644,
    flag: "wx",
  });
  await options.assetStore?.put(storageKey, bytes, "image/jpeg");
  let svgStorageKey: string | undefined;
  if (svg) {
    svgStorageKey = `${assetId}.svg`;
    await writeFile(join(options.storageDir, svgStorageKey), svg, {
      mode: 0o644,
      flag: "wx",
    });
    await options.assetStore?.put(svgStorageKey, svg, "image/svg+xml");
  }
  await options.db.query(
    `INSERT INTO assets (id, created_by, source, kind, status, storage_key, mime_type, metadata)
     VALUES ($1, $2, 'case_diagram', 'image', 'ready', $3, 'image/jpeg', $4::jsonb)`,
    [
      assetId,
      options.createdBy,
      storageKey,
      JSON.stringify({
        contentJobId: options.contentJobId,
        operationId: request.operationId,
        role: visualType === "cover" ? "cover" : "inline",
        caseVisualType: visualType,
        diagramSkill: visualType === "cover" ? undefined : "gd-biz-chart@1.0.0",
        svgStorageKey,
        width: 1620,
        height: 2160,
        ossBacked: Boolean(options.assetStore),
        ...generationMetadata,
      }),
    ],
  );
  await options.db.query(
    "INSERT INTO asset_blobs (asset_id, bytes) VALUES ($1, $2) ON CONFLICT (asset_id) DO UPDATE SET bytes = EXCLUDED.bytes",
    [assetId, Buffer.from(bytes)],
  );
  return {
    id: assetId,
    title,
    url: publicAssetUrl(options, assetId),
    primaryTag: request.primaryTag,
    secondaryTags: request.secondaryTags ?? [],
    tags: ["小红书", "3:4", "项目案例", visualType],
    description: `${request.topic} 的极客跳动案例${title}`,
    usageCount: 0,
    authorized: true,
    containsPerson: false,
  } satisfies MaterialCandidate;
}

async function generateCaseContentImages(
  options: ContentImageOptions,
  request: ContentJobRequest,
  article: CoreArticle,
  evidence: EvidenceItem[],
  attachments: ResearchAttachment[],
  onProgress?: (completed: number, total: number) => Promise<void> | void,
) {
  if (!options.caseDiagramSpecGenerator)
    throw new Error("CASE_DIAGRAM_SPEC_GENERATOR_MISSING");
  const visualTypes = request.caseVisualTypes ?? [];
  const total = visualTypes.length;
  const screenReferences = attachmentImageSources(attachments);
  const screenReferenceInstruction = screenReferences.length
    ? `输入中包含 ${screenReferences.length} 张用户上传并授权的产品界面或项目图片。选择最能代表项目的一张作为手机屏幕核心内容，高保真保留它的信息架构、真实照片、颜色关系和功能层级；只允许为适配手机透视进行裁切和变形，不得重画成概念图，不得替换为虚构界面。封面外围仍保持极客跳动红白黑，手机屏幕内部允许保留原产品的真实颜色。`
    : "没有可用的真实产品截图时，生成接近可交付产品的高保真概念界面：使用真实行业照片、合理移动端导航、安全区、间距、卡片层级和交互状态，但不得生成可读小字、客户品牌、指标或声称它是真实上线截图。";
  const coverPrompt = `为极客跳动项目案例“${article.title}”生成小红书 3:4 竖版封面底图。项目摘要：${article.description}。结合开场：${article.opening.slice(0, 2).join(" ")}。采用高信息密度的软件交付案例封面：深黑与炭黑占主导，纯白结构，极客跳动红 #DA251C 用于边缘光、色块和一个焦点；封面外围只使用红、白、黑三色。上方 30% 至 38% 是经过设计的深色标题区，但不得生成文字；下方或右下 45% 至 55% 必须以一台接近真实商业产品摄影的旗舰智能手机作为唯一核心主体：精确金属边框、合理厚度与窄边框、玻璃反射、自然透视、接触阴影和棚拍轮廓光，禁止扁平矢量、塑料 3D 玩具感或变形设备。${screenReferenceInstruction} 手机屏幕必须通过真实业务照片、功能分区与交互层级体现极客跳动的软件设计和交付能力，让人不看标题也能判断项目行业；不能使用空白屏幕、通用卡片、圆圈或横线占位。手机至少占画面三分之一，完整清晰且适合缩略图识别。画面不得出现连续超过约 15% 的无内容空区，不得做米白文章插图、PPT 页面、浏览器界面或居中展示卡片。右上角预留真实 Logo 后贴区域。不要生成标题、Logo、水印、绿色或黄色标题块、通用机器人、发光球体、拼贴、多手机阵列、人物手部、虚构可读小字、虚构指标或无法从案例理解的技术元素；中文标题和极客跳动 Logo 将由程序确定性后处理。`;
  let cover: Uint8Array;
  let coverCostCents = 0;
  let coverMetadata: Record<string, unknown>;
  try {
    const generated = await generateAiImages(
      {
        providerMode: options.providerMode,
        imageApiKey: options.imageApiKey,
        imageBaseUrl: options.imageBaseUrl,
        model: options.model,
        allowedResultHosts: options.allowedResultHosts,
      },
      {
        operationId: request.operationId,
        operation: "generate",
        prompt: coverPrompt,
        sourceAssetIds: [],
        ratio: "3:4",
        count: 1,
        quality: "high",
        rightsConfirmed: true,
      },
      screenReferences,
    );
    if (!generated.outputs[0]) throw new Error("CASE_COVER_INCOMPLETE");
    cover = await overlayCaseCoverTitle(
      generated.outputs[0],
      article.title,
      options.logoPath,
    );
    coverCostCents = generated.costCents;
    coverMetadata = {
      coverGenerator: "openrouter",
      model: options.model,
      prompt: coverPrompt,
      referenceImageCount: screenReferences.length,
    };
  } catch (error) {
    const providerErrorCode =
      error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN";
    console.warn(
      `[case-cover] provider unavailable; using deterministic cover (${providerErrorCode})`,
    );
    cover = await renderFallbackCaseCover(article.title, article.description, {
      logoPath: options.logoPath,
      mascotPath: options.mascotPath,
    });
    coverMetadata = {
      coverGenerator: "deterministic_fallback",
      requestedModel: options.model,
      providerErrorCode,
    };
  }
  const candidates: MaterialCandidate[] = [];
  candidates.push(
    await persistCaseVisual(
      options,
      request,
      cover,
      "cover",
      "案例封面",
      undefined,
      coverMetadata,
    ),
  );
  await onProgress?.(1, total);
  const specs = await options.caseDiagramSpecGenerator(
    request,
    evidence,
    attachments,
  );
  const names: Record<string, string> = {
    function: "功能全览图",
    flow: "业务流程图",
    roles: "角色协同图",
    architecture: "系统架构图",
  };
  for (const spec of specs) {
    const rendered = await renderCaseDiagram(spec, {
      logoPath: options.logoPath,
      mascotPath: options.mascotPath,
    });
    const jpeg = await import("sharp").then(({ default: sharp }) =>
      sharp(rendered.png)
        .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
        .toBuffer(),
    );
    candidates.push(
      await persistCaseVisual(
        options,
        request,
        jpeg,
        spec.diagramType,
        names[spec.diagramType] ?? "项目图",
        rendered.svg,
      ),
    );
    await onProgress?.(candidates.length, total);
  }
  await options.db.query(
    "UPDATE content_jobs SET image_cost_cents = image_cost_cents + $1 WHERE id = $2",
    [coverCostCents, options.contentJobId],
  );
  return candidates;
}
