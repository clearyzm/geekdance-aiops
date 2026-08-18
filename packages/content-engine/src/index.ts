import type {
  Channel,
  ContentJobRequest,
  EvidenceItem,
  CoreArticle,
  ResearchAttachment,
} from "@geekdance/shared";
import { channelLabels } from "@geekdance/shared";
import { brandHumanize } from "./humanizer.js";
import { classifyContentScope } from "./classifier.js";
import {
  buildXiaohongshuNote,
  renderWechatHtml,
  renderWebsiteHtml,
  renderXiaohongshuHtml,
} from "./layout.js";
import { selectMaterial, type MaterialCandidate } from "./material-selector.js";
import { runChannelQa } from "./qa.js";
import { mockMaterials, mockResearch, mockWrite } from "./mock.js";
import { WORKFLOW_VERSION } from "./rules.js";
import {
  getChannelTemplateRef,
  type ChannelTemplateRef,
} from "./channel-templates.js";

export * from "./classifier.js";
export * from "./humanizer.js";
export * from "./layout.js";
export * from "./material-selector.js";
export * from "./qa.js";
export * from "./rules.js";
export * from "./live.js";
export * from "./channel-templates.js";
export * from "./case-visuals.js";
export * from "./editorial-ending.js";

export type ContentEnginePorts = {
  research: (
    request: ContentJobRequest,
    attachments: ResearchAttachment[],
  ) => Promise<EvidenceItem[]>;
  write: (
    request: ContentJobRequest,
    evidence: EvidenceItem[],
    channel: Channel,
    revisionNotes?: string[],
    attachments?: ResearchAttachment[],
  ) => Promise<CoreArticle>;
  searchMaterials: (request: ContentJobRequest) => Promise<MaterialCandidate[]>;
  generateImages: (
    request: ContentJobRequest,
    article: CoreArticle,
    evidence?: EvidenceItem[],
    attachments?: ResearchAttachment[],
    onProgress?: (completed: number, total: number) => Promise<void> | void,
  ) => Promise<MaterialCandidate[]>;
};

export type ContentPipelineProgress = {
  phase: string;
  fraction: number;
  stage: "researching" | "writing" | "formatting";
  message: string;
};

export const mockPorts: ContentEnginePorts = {
  research: async (request, attachments) => mockResearch(request, attachments),
  write: async (request, _evidence, channel) => mockWrite(request, channel),
  searchMaterials: async (request) => mockMaterials(request),
  generateImages: async (request) =>
    mockMaterials(request).map((material, index) => ({
      ...material,
      id: `mock-generated-${index + 1}`,
      title: `Mock AI 品牌配图 ${index + 1}`,
      url: `https://mock.openrouter.local/generated-${index + 1}.png`,
      usageCount: 0,
    })),
};

export type ChannelArtifact = {
  channel: Channel;
  status: "ready" | "manual_review";
  template: ChannelTemplateRef;
  article?: CoreArticle;
  html?: string;
  note?: import("@geekdance/shared").XiaohongshuNote;
  assets: ReturnType<typeof selectMaterial>[];
  qaReport?: ReturnType<typeof runChannelQa>;
  reason?: string;
  reviewedCoverUrl?: string;
  reviewedCover?: {
    id?: string;
    title: string;
    url: string;
    metadata?: Record<string, unknown>;
  };
};

function requireGeekHomeSelection(request: ContentJobRequest) {
  return request.imageMode === "geekhome" && !request.includeGeekHome;
}

async function buildChannelArtifact(
  request: ContentJobRequest,
  evidence: EvidenceItem[],
  ports: ContentEnginePorts,
  channel: Channel,
  attachments: ResearchAttachment[],
  onProgress?: (progress: ContentPipelineProgress) => Promise<void> | void,
  assetSelectionChannel: Channel = channel,
  assetSelectionTitle?: string,
): Promise<ChannelArtifact> {
  const template = getChannelTemplateRef(channel, request.contentType);
  const channelRequest = { ...request, targets: [channel] };
  const channelName = channelLabels[channel];
  await onProgress?.({
    phase: `${channel}:write`,
    fraction: 0.05,
    stage: "writing",
    message: `正在生成${channelName}文章初稿`,
  });
  const requestedTitle = request.title?.trim();
  const applyRequestedTitle = (value: CoreArticle): CoreArticle => ({
    ...brandHumanize(value),
    ...(requestedTitle ? { title: requestedTitle } : {}),
  });
  let article = applyRequestedTitle(
    await ports.write(channelRequest, evidence, channel, [], attachments),
  );
  await onProgress?.({
    phase: `${channel}:write`,
    fraction: 1,
    stage: "writing",
    message: `${channelName}文章初稿已完成`,
  });
  await onProgress?.({
    phase: `${channel}:assets`,
    fraction: 0.05,
    stage: "writing",
    message: !requireGeekHomeSelection(request)
      ? request.targets.includes("xiaohongshu")
        ? "正在准备 6 张多渠道共用章节插图和小红书独立封面"
        : "正在准备多渠道共用的 6 张章节插图"
      : "正在准备多渠道共用的 GeekHome 素材",
  });
  const materials = requireGeekHomeSelection(request)
    ? await ports.searchMaterials(channelRequest)
    : await ports.generateImages(
        channelRequest,
        article,
        evidence,
        attachments,
        async (completed, total) =>
          onProgress?.({
            phase: `${channel}:assets`,
            fraction: total ? completed / total : 0,
            stage: "writing",
            message: `正在生成内容配图（${completed}/${total}）`,
          }),
      );
  await onProgress?.({
    phase: `${channel}:assets`,
    fraction: 1,
    stage: "writing",
    message: !requireGeekHomeSelection(request)
      ? request.targets.includes("xiaohongshu")
        ? "共享正文插图与小红书独立封面已准备完成"
        : "多渠道共用插图已准备完成"
      : "多渠道共用素材已准备完成",
  });
  const assets: ReturnType<typeof selectMaterial>[] = [];
  const remaining = [...materials];
  if (request.contentType === "case") {
    for (const material of materials)
      assets.push({
        selected: material,
        selectedIdentity: material.id ?? material.url ?? "case-visual",
        usageCountBefore: material.usageCount ?? 0,
        score: 100,
        selectionReason: "附件证据驱动的案例项目图，保持用户选择顺序",
        manualReview: false,
        reason: "",
        rankedCandidates: [],
      });
  }
  if (request.contentType !== "case" && !requireGeekHomeSelection(request)) {
    for (const material of materials)
      assets.push({
        selected: material,
        selectedIdentity: material.id ?? material.url ?? "generated-visual",
        usageCountBefore: material.usageCount ?? 0,
        score: 100,
        selectionReason: "依据当前章节正文确定性生成，按文章章节顺序直接使用",
        manualReview: false,
        reason: "",
        rankedCandidates: [],
      });
  }
  const standardIntents = !requireGeekHomeSelection(request)
    ? article.sections
        .slice(0, Math.max(2, Math.min(4, materials.length)))
        .map(() => "inline")
    : ["cover", "inline", "inline"];
  for (const [index, intent] of (request.contentType === "case" ||
  !requireGeekHomeSelection(request)
    ? []
    : standardIntents
  ).entries()) {
    const selection = selectMaterial({
      topic: request.topic,
      title: assetSelectionTitle ?? article.title,
      primaryTag: request.primaryTag,
      secondaryTags: request.secondaryTags,
      imageIntent: intent as "cover" | "inline",
      targetPlatform: assetSelectionChannel,
      operationId: `${request.operationId}:${assetSelectionChannel}:${index}`,
      candidates: remaining,
    });
    assets.push(selection);
    if (selection.selected) {
      const position = remaining.findIndex(
        (candidate) =>
          (selection.selected?.id && candidate.id === selection.selected.id) ||
          candidate.url === selection.selected?.url,
      );
      if (position >= 0) remaining.splice(position, 1);
    }
  }
  const reviewAsset = assets.find((asset) => asset.manualReview);
  if (reviewAsset) {
    await onProgress?.({
      phase: `${channel}:qa`,
      fraction: 1,
      stage: "formatting",
      message: `${channelName}素材需要人工复核`,
    });
    return {
      channel,
      status: "manual_review",
      template,
      article,
      assets,
      reason: reviewAsset.reason || "素材需要人工审核",
    };
  }
  const imageUrls = assets.flatMap((asset) =>
    asset.selected?.url ? [asset.selected.url] : [],
  );
  const requiredImageCount =
    request.contentType === "case"
      ? (request.caseVisualTypes?.length ?? 0)
      : standardIntents.length;
  if (imageUrls.length < requiredImageCount) {
    await onProgress?.({
      phase: `${channel}:qa`,
      fraction: 1,
      stage: "formatting",
      message: `${channelName}配图数量不足，需要人工复核`,
    });
    return {
      channel,
      status: "manual_review",
      template,
      article,
      assets,
      reason: requireGeekHomeSelection(request)
        ? "没有足够的高相关 GeekHome 素材"
        : "AI 配图生成不完整",
    };
  }

  await onProgress?.({
    phase: `${channel}:qa`,
    fraction: 0.2,
    stage: "formatting",
    message: `正在生成${channelName}排版并执行首次质检`,
  });

  let note =
    channel === "xiaohongshu"
      ? buildXiaohongshuNote(article, request)
      : undefined;
  const render = (value: CoreArticle) => {
    if (channel === "official_site")
      return renderWebsiteHtml(
        value,
        !requireGeekHomeSelection(request) ? imageUrls : imageUrls.slice(1),
      );
    if (channel === "wechat")
      return renderWechatHtml(
        value,
        !requireGeekHomeSelection(request) ? imageUrls : imageUrls.slice(1),
        undefined,
        undefined,
        undefined,
        request.wechatEnding,
      );
    if (channel === "xiaohongshu") {
      note = buildXiaohongshuNote(value, request);
      return renderXiaohongshuHtml(note, imageUrls);
    }
    return renderWebsiteHtml(
      value,
      !requireGeekHomeSelection(request) ? imageUrls : imageUrls.slice(1),
    );
  };
  let html = render(article);
  let qaReport = runChannelQa(channel, article, evidence, html, 0, request);
  for (let revision = 1; !qaReport.passed && revision <= 2; revision += 1) {
    await onProgress?.({
      phase: `${channel}:qa`,
      fraction: 0.25 + revision * 0.25,
      stage: "formatting",
      message: `正在根据质检结果修订${channelName}内容（${revision}/2）`,
    });
    article = applyRequestedTitle(
      await ports.write(
        channelRequest,
        evidence,
        channel,
        qaReport.errors,
        attachments,
      ),
    );
    html = render(article);
    qaReport = runChannelQa(
      channel,
      article,
      evidence,
      html,
      revision,
      request,
    );
  }
  await onProgress?.({
    phase: `${channel}:qa`,
    fraction: 1,
    stage: "formatting",
    message: qaReport.passed
      ? `${channelName}排版与质检已完成`
      : `${channelName}质检未通过，需要人工复核`,
  });
  if (!qaReport.passed)
    return {
      channel,
      status: "manual_review",
      template,
      article,
      html,
      note,
      assets,
      qaReport,
      reason: "两轮修订后仍未通过渠道质检",
    };
  return {
    channel,
    status: "ready",
    template,
    article,
    html,
    note,
    assets,
    qaReport,
  };
}

function aggregateQa(artifacts: ChannelArtifact[]) {
  const reports = artifacts.flatMap((artifact) =>
    artifact.qaReport ? [[artifact.channel, artifact.qaReport] as const] : [],
  );
  const ready = artifacts.filter((artifact) => artifact.status === "ready");
  const errors = artifacts.flatMap((artifact) =>
    artifact.status === "manual_review"
      ? [`${artifact.channel}：${artifact.reason ?? "需要人工复核"}`]
      : [],
  );
  for (const [channel, report] of reports)
    errors.push(...report.errors.map((error) => `${channel}：${error}`));
  return {
    passed: ready.length === artifacts.length,
    revisionCount: Math.max(
      0,
      ...reports.map(([, report]) => report.revisionCount),
    ),
    score: reports.length
      ? Math.min(50, ...reports.map(([, report]) => report.score))
      : 0,
    dimensions: reports[0]?.[1].dimensions ?? {
      directness: 0,
      rhythm: 0,
      trust: 0,
      naturalness: 0,
      concision: 0,
    },
    errors,
    warnings: reports.flatMap(([channel, report]) =>
      report.warnings.map((warning) => `${channel}：${warning}`),
    ),
    websiteLayout: reports.find(([channel]) => channel === "official_site")?.[1]
      .websiteLayout,
    wechatLayout: reports.find(([channel]) => channel === "wechat")?.[1]
      .wechatLayout,
    xiaohongshuLayout: reports.find(
      ([channel]) => channel === "xiaohongshu",
    )?.[1].xiaohongshuLayout,
  };
}

export async function runContentPipeline(
  request: ContentJobRequest,
  ports: ContentEnginePorts = mockPorts,
  attachments: ResearchAttachment[] = [],
  onProgress?: (progress: ContentPipelineProgress) => Promise<void> | void,
) {
  const classification = classifyContentScope(
    request.topic,
    request.title,
    request.remarks,
  );
  if (classification.scope === "case" && request.contentType !== "case") {
    return {
      status: "manual_review" as const,
      workflowVersion: WORKFLOW_VERSION,
      route: classification.route,
      reason: "检测到案例内容，请显式选择“案例文章”并上传项目材料",
    };
  }

  await onProgress?.({
    phase: "research",
    fraction: 0.05,
    stage: "researching",
    message: "正在检索并核验资料来源",
  });
  const evidence = await ports.research(request, attachments);
  await onProgress?.({
    phase: "research",
    fraction: 1,
    stage: "researching",
    message: `证据清单已建立（${evidence.length} 项）`,
  });
  if (!evidence.length)
    return {
      status: "manual_review" as const,
      workflowVersion: WORKFLOW_VERSION,
      reason: "没有可追溯证据",
    };
  // 所有文章渠道共用同一组 4:3 正文插图以避免重复计费；小红书另生成
  // 一张 3:4 竖版封面，官网、公众号和小红书封面不再混用。
  let sharedMaterials: Promise<MaterialCandidate[]> | undefined;
  const artifactsInOrder: ChannelArtifact[] = [];
  const channelPriority: Record<Channel, number> = {
    official_site: 0,
    wechat: 1,
    xiaohongshu: 2,
    zhihu: 3,
    toutiao: 4,
    baijiahao: 5,
    linkedin: 6,
  };
  const channelsInGenerationOrder = [...request.targets].sort(
    (left, right) => channelPriority[left] - channelPriority[right],
  );
  const sharedSelectionChannel = request.targets.includes("official_site")
    ? "official_site"
    : request.targets.includes("wechat")
      ? "wechat"
      : request.targets.includes("xiaohongshu")
        ? "xiaohongshu"
        : request.targets[0]!;
  for (const channel of channelsInGenerationOrder) {
    const channelPorts = {
      ...ports,
      ...(!requireGeekHomeSelection(request)
        ? {
            generateImages: (
              channelRequest: ContentJobRequest,
              article: CoreArticle,
              channelEvidence?: EvidenceItem[],
              channelAttachments?: ResearchAttachment[],
              imageProgress?: (
                completed: number,
                total: number,
              ) => Promise<void> | void,
            ) => {
              if (sharedMaterials) return sharedMaterials;
              const pending = ports.generateImages(
                { ...channelRequest, targets: request.targets },
                article,
                channelEvidence,
                channelAttachments,
                imageProgress,
              );
              sharedMaterials = pending;
              return pending;
            },
          }
        : {
            searchMaterials: (channelRequest: ContentJobRequest) => {
              if (sharedMaterials) return sharedMaterials;
              const pending = ports.searchMaterials(channelRequest);
              sharedMaterials = pending;
              return pending;
            },
          }),
    };
    const assetSelectionChannel = sharedSelectionChannel;
    const assetSelectionTitle =
      request.targets.length > 1
        ? request.title?.trim() || request.topic
        : undefined;
    artifactsInOrder.push(
      await buildChannelArtifact(
        request,
        evidence,
        channelPorts,
        channel,
        attachments,
        onProgress,
        assetSelectionChannel,
        assetSelectionTitle,
      ),
    );
  }
  const channelArtifacts = Object.fromEntries(
    artifactsInOrder.map((artifact) => [artifact.channel, artifact]),
  ) as Partial<Record<Channel, ChannelArtifact>>;
  const artifacts = request.targets.map(
    (channel) => channelArtifacts[channel]!,
  );
  const qaReport = aggregateQa(artifacts);
  const templateVersions = Object.fromEntries(
    artifacts.map((artifact) => [artifact.channel, artifact.template]),
  ) as Partial<Record<Channel, ChannelTemplateRef>>;
  const primaryArtifact =
    artifacts.find((artifact) => artifact.status === "ready") ?? artifacts[0]!;
  const websiteArtifact = channelArtifacts.official_site;
  const wechatArtifact = channelArtifacts.wechat;
  const xiaohongshuArtifact = channelArtifacts.xiaohongshu;
  const zhihuArtifact = channelArtifacts.zhihu;
  const toutiaoArtifact = channelArtifacts.toutiao;
  const baijiahaoArtifact = channelArtifacts.baijiahao;
  const linkedinArtifact = channelArtifacts.linkedin;
  if (artifacts.every((artifact) => artifact.status === "manual_review"))
    return {
      status: "manual_review" as const,
      workflowVersion: WORKFLOW_VERSION,
      reason: artifacts.map((artifact) => artifact.reason).join("；"),
      evidence,
      article: primaryArtifact.article,
      qaReport,
      websiteHtml: websiteArtifact?.html,
      wechatHtml: wechatArtifact?.html,
      xiaohongshuHtml: xiaohongshuArtifact?.html,
      zhihuHtml: zhihuArtifact?.html,
      toutiaoHtml: toutiaoArtifact?.html,
      baijiahaoHtml: baijiahaoArtifact?.html,
      linkedinHtml: linkedinArtifact?.html,
      assets: artifacts.flatMap((artifact) => artifact.assets),
      channelArtifacts,
      templateVersions,
    };
  return {
    status: "ready" as const,
    workflowVersion: WORKFLOW_VERSION,
    evidence,
    article: primaryArtifact.article!,
    qaReport,
    websiteHtml: websiteArtifact?.html,
    wechatHtml: wechatArtifact?.html,
    xiaohongshuHtml: xiaohongshuArtifact?.html,
    zhihuHtml: zhihuArtifact?.html,
    toutiaoHtml: toutiaoArtifact?.html,
    baijiahaoHtml: baijiahaoArtifact?.html,
    linkedinHtml: linkedinArtifact?.html,
    assets: artifacts.flatMap((artifact) => artifact.assets),
    channelArtifacts,
    templateVersions,
    systemPromptVersion: WORKFLOW_VERSION,
  };
}
