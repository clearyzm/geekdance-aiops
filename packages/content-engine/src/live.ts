import {
  type Channel,
  channelLabels,
  coreArticleSchema,
  evidenceItemSchema,
  type ContentJobRequest,
  type CoreArticle,
  type EvidenceItem,
  type ResearchAttachment,
} from "@geekdance/shared";
import { z } from "zod";
import type { ContentEnginePorts } from "./index.js";
import type { MaterialCandidate } from "./material-selector.js";
import { getChannelTemplate } from "./channel-templates.js";
import {
  CASE_DIAGRAM_JSON_CONTRACT,
  validateCaseDiagramSpecs,
} from "./case-visuals.js";
import { COMMERCIAL_EDITORIAL_DIRECTION } from "./rules.js";

export type LiveContentConfig = {
  textProvider?: "openrouter" | "openai";
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterFallbackModels?: string[];
  geekHomeUrl: string;
  geekHomeToken: string;
  openRouterTextBaseUrl?: string;
  openRouterBaseUrl?: string;
  openRouterProviderOrder?: string[];
  openRouterTimeoutMs?: number;
  openAiReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  openAiResearchFallbackModel?: string;
  imageGenerator?: (
    request: ContentJobRequest,
    article: CoreArticle,
    evidence?: EvidenceItem[],
    attachments?: ResearchAttachment[],
    onProgress?: (completed: number, total: number) => Promise<void> | void,
  ) => Promise<MaterialCandidate[]>;
  usageRecorder?: (usage: {
    totalTokens: number;
    costCents: number;
  }) => Promise<void>;
  modelRecorder?: (model: string) => Promise<void> | void;
};

export type GeekHomeConfig = Pick<
  LiveContentConfig,
  "geekHomeUrl" | "geekHomeToken"
>;

const evidenceResponseSchema = z.object({
  evidence: z.array(evidenceItemSchema).min(1).max(12),
});

const evidenceJsonContract = `{
  "evidence": [
    {
      "id": "唯一且非空的来源ID",
      "title": "真实来源标题",
      "url": "https://真实来源地址",
      "sourceType": "primary|authoritative|internal|user_attachment",
      "claims": ["该来源可以直接支持的事实"],
      "accessedAt": "ISO 8601时间"
    }
  ]
}
约束：evidence 必须有1至12项；claims 必须是非空字符串数组；不得虚构 URL、标题、数字或结论；不得输出 null、Markdown 或 HTML。`;

const coreArticleJsonContract = `{
  "title": "非空字符串",
  "description": "非空字符串",
  "opening": ["开场段落1", "开场段落2"],
  "sections": [
    {
      "heading": "小标题",
      "paragraphs": ["正文段落，至少1段"],
      "bullets": ["可选要点；没有要点时必须为[]"]
    }
  ],
  "observation": "观察与判断",
  "conclusion": "结论",
  "cta": "自然的服务引导",
  "evidenceIds": ["只能填写输入证据中真实存在的id"]
}
约束：opening 至少2项；sections 必须为3至5项；每个 section 必须同时包含 heading、paragraphs、bullets；所有字段都必须存在；不得增加字段；不得输出 null、Markdown 或 HTML。`;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstDefined(
  record: Record<string, unknown>,
  names: string[],
): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function normalizedString(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  const record = recordOf(value);
  if (record)
    return normalizedString(
      firstDefined(record, ["text", "content", "value", "claim"]),
    );
  return value;
}

function normalizedStringArray(
  value: unknown,
  options: { splitLines?: boolean } = {},
): unknown {
  if (Array.isArray(value))
    return value
      .map(normalizedString)
      .filter((item) => typeof item === "string" && item.length > 0);
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (!options.splitLines) return [trimmed];
  return trimmed
    .split(/\n+/)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean);
}

function normalizeEvidencePayload(payload: unknown): unknown {
  if (Array.isArray(payload))
    return normalizeEvidencePayload({ evidence: payload });
  const root = recordOf(payload);
  if (!root) return payload;
  const wrapped = recordOf(firstDefined(root, ["data", "result"])) ?? root;
  const rawEvidence = firstDefined(wrapped, ["evidence", "sources", "items"]);
  if (!Array.isArray(rawEvidence)) return { evidence: rawEvidence };
  return {
    evidence: rawEvidence.map((value) => {
      const item = recordOf(value);
      if (!item) return value;
      const rawSourceType = normalizedString(
        firstDefined(item, ["sourceType", "source_type", "type"]),
      );
      const sourceType =
        typeof rawSourceType === "string"
          ? ({
              official: "authoritative",
              authority: "authoritative",
              government: "authoritative",
              first_party: "primary",
              firstParty: "primary",
              attachment: "user_attachment",
              userAttachment: "user_attachment",
              权威来源: "authoritative",
              官方来源: "authoritative",
              一手来源: "primary",
              内部资料: "internal",
              用户附件: "user_attachment",
            }[rawSourceType] ?? rawSourceType)
          : rawSourceType;
      return {
        id: normalizedString(
          firstDefined(item, ["id", "sourceId", "source_id"]),
        ),
        title: normalizedString(firstDefined(item, ["title", "name"])),
        url: normalizedString(firstDefined(item, ["url", "link", "sourceUrl"])),
        sourceType,
        claims: normalizedStringArray(
          firstDefined(item, ["claims", "keyClaims", "statements", "claim"]),
          { splitLines: true },
        ),
        accessedAt: normalizedString(
          firstDefined(item, [
            "accessedAt",
            "accessed_at",
            "retrievedAt",
            "accessDate",
          ]),
        ),
      };
    }),
  };
}

function splitOpening(value: unknown, description: unknown) {
  const opening = normalizedStringArray(value, { splitLines: true });
  if (!Array.isArray(opening)) return opening;
  if (opening.length >= 2) return opening;
  const firstOpening = opening[0];
  if (opening.length === 1 && typeof firstOpening === "string") {
    const sentences = firstOpening
      .split(/(?<=[。！？!?])\s*/)
      .map((item: string) => item.trim())
      .filter(Boolean);
    if (sentences.length >= 2) {
      const midpoint = Math.ceil(sentences.length / 2);
      return [
        sentences.slice(0, midpoint).join(""),
        sentences.slice(midpoint).join(""),
      ];
    }
  }
  const fallback = normalizedString(description);
  if (typeof fallback === "string" && fallback)
    return opening.length ? [opening[0], fallback] : [fallback, fallback];
  return opening;
}

function normalizeSections(value: unknown) {
  const sectionRecord = recordOf(value);
  const rawSections = Array.isArray(value)
    ? value
    : sectionRecord
      ? Object.values(sectionRecord)
      : value;
  if (!Array.isArray(rawSections)) return rawSections;
  const sections = rawSections.flatMap((rawSection) => {
    const section = recordOf(rawSection);
    if (!section) return [];
    const paragraphs = normalizedStringArray(
      firstDefined(section, ["paragraphs", "content", "body", "text"]),
      { splitLines: true },
    );
    return [
      {
        heading: normalizedString(
          firstDefined(section, ["heading", "title", "subtitle"]),
        ),
        paragraphs,
        bullets:
          normalizedStringArray(
            firstDefined(section, ["bullets", "points", "list"]),
            { splitLines: true },
          ) ?? [],
      },
    ];
  });
  if (sections.length <= 5) return sections;
  const retained = sections.slice(0, 4);
  const overflow = sections.slice(4);
  retained.push({
    heading: overflow[0]?.heading,
    paragraphs: overflow.flatMap((section) =>
      Array.isArray(section.paragraphs) ? section.paragraphs : [],
    ),
    bullets: overflow.flatMap((section) =>
      Array.isArray(section.bullets) ? section.bullets : [],
    ),
  });
  return retained;
}

function completeSections(
  value: unknown,
  observation: unknown,
  conclusion: unknown,
) {
  if (!Array.isArray(value)) return value;
  const sections = value.filter(
    (section) =>
      recordOf(section) &&
      Array.isArray(section.paragraphs) &&
      section.paragraphs.length > 0,
  );
  while (sections.length < 3) {
    const splitIndex = sections.findIndex(
      (section) =>
        Array.isArray(section.paragraphs) && section.paragraphs.length > 1,
    );
    if (splitIndex >= 0) {
      const source = sections[splitIndex]!;
      const midpoint = Math.ceil(source.paragraphs.length / 2);
      const remainder = source.paragraphs.splice(midpoint);
      sections.splice(splitIndex + 1, 0, {
        heading: `${String(source.heading ?? "")}（续）`,
        paragraphs: remainder,
        bullets: [],
      });
      continue;
    }
    const fallback = [observation, conclusion].find(
      (candidate) =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        !sections.some((section) => section.paragraphs.includes(candidate)),
    );
    if (!fallback) break;
    sections.push({
      heading: sections.length === 1 ? "进一步观察" : "落地建议",
      paragraphs: [fallback],
      bullets: [],
    });
  }
  return sections;
}

function normalizeCoreArticlePayload(
  payload: unknown,
  options: { completeSections?: boolean } = {},
): unknown {
  const root = recordOf(payload);
  if (!root) return payload;
  const wrapped =
    recordOf(firstDefined(root, ["article", "coreArticle", "data"])) ?? root;
  const rawNormalizedSections = normalizeSections(
    firstDefined(wrapped, ["sections", "bodySections"]),
  );
  const rawEvidenceIds = firstDefined(wrapped, [
    "evidenceIds",
    "evidence_ids",
    "citations",
  ]);
  const evidenceIds = Array.isArray(rawEvidenceIds)
    ? rawEvidenceIds.map((value) => {
        const citation = recordOf(value);
        return normalizedString(
          firstDefined(citation ?? {}, ["id", "sourceId", "source_id"]) ??
            value,
        );
      })
    : normalizedStringArray(rawEvidenceIds, { splitLines: true });
  const description = normalizedString(
    firstDefined(wrapped, ["description", "摘要", "summaryDescription"]),
  );
  const observation = normalizedString(
    firstDefined(wrapped, ["observation", "insight", "keyObservation"]),
  );
  const conclusion = normalizedString(
    firstDefined(wrapped, ["conclusion", "summary"]),
  );
  const sections = options.completeSections
    ? completeSections(rawNormalizedSections, observation, conclusion)
    : rawNormalizedSections;

  return {
    title: normalizedString(firstDefined(wrapped, ["title", "headline"])),
    description,
    opening: splitOpening(
      firstDefined(wrapped, ["opening", "introduction", "intro"]),
      description,
    ),
    sections,
    observation,
    conclusion,
    cta: normalizedString(
      firstDefined(wrapped, ["cta", "callToAction", "call_to_action"]),
    ),
    evidenceIds,
  };
}

function compactSchemaIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    code: issue.code,
    message: issue.message,
  }));
}

function jsonContent(payload: unknown) {
  const parsed = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              content: z.union([
                z.string(),
                z.array(
                  z.object({ type: z.string(), text: z.string().optional() }),
                ),
              ]),
            }),
          }),
        )
        .min(1),
    })
    .parse(payload);
  const content = parsed.choices[0]!.message.content;
  const text =
    typeof content === "string"
      ? content
      : content.map((item) => item.text ?? "").join("");
  const normalized = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(normalized) as unknown;
  } catch (error) {
    const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    const objectStart = normalized.indexOf("{");
    const objectEnd = normalized.lastIndexOf("}");
    const candidate =
      fenced ??
      (objectStart >= 0 && objectEnd > objectStart
        ? normalized.slice(objectStart, objectEnd + 1)
        : "");
    if (!candidate) throw error;
    return JSON.parse(candidate) as unknown;
  }
}

type OpenRouterFailure =
  | "REGION_BLOCKED"
  | "WEB_SEARCH_UNAVAILABLE"
  | "DATA_POLICY_BLOCKED"
  | "PROVIDER_TOS_BLOCKED"
  | "PROVIDER_UNAVAILABLE"
  | "KEY_REJECTED"
  | "CREDITS_REQUIRED"
  | "MODEL_ACCESS_FORBIDDEN"
  | "FORBIDDEN";

async function classifyOpenRouterFailure(
  response: Response,
  webSearch: boolean,
): Promise<OpenRouterFailure> {
  const raw = (
    await response
      .clone()
      .text()
      .catch(() => "")
  ).slice(0, 4_000);
  let error: Record<string, any> = {};
  try {
    const payload = JSON.parse(raw) as Record<string, any>;
    error =
      payload.error && typeof payload.error === "object" ? payload.error : {};
  } catch {
    // Some gateways return HTML or plain text. The bounded raw response is
    // still sufficient for classification and is never exposed verbatim.
  }
  const metadata =
    error.metadata && typeof error.metadata === "object" ? error.metadata : {};
  const diagnostic = [
    error.code,
    error.message,
    metadata.provider_name,
    metadata.raw,
    raw,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (
    /not available in your region|region.?restricted|regional restriction|unsupported country|country.?blocked/.test(
      diagnostic,
    )
  )
    return "REGION_BLOCKED";
  if (
    webSearch &&
    /web.?search|web plugin|plugin.?web|tool.?web|online search/.test(
      diagnostic,
    )
  )
    return "WEB_SEARCH_UNAVAILABLE";
  if (
    /data polic|privacy polic|provider privacy|training data|data retention/.test(
      diagnostic,
    )
  )
    return "DATA_POLICY_BLOCKED";
  if (/terms of service|provider tos|tos violation/.test(diagnostic))
    return "PROVIDER_TOS_BLOCKED";
  if (
    /invalid api key|api key.*invalid|key.*revoked|authentication failed|unauthorized bearer|invalid bearer/.test(
      diagnostic,
    )
  )
    return "KEY_REJECTED";
  if (/credit|payment|balance|quota|insufficient funds/.test(diagnostic))
    return "CREDITS_REQUIRED";
  if (
    /no provider available|no endpoints? found|provider unavailable|upstream unavailable|provider routing|temporarily unavailable/.test(
      diagnostic,
    )
  )
    return "PROVIDER_UNAVAILABLE";
  if (
    /model access forbidden|model.*not (?:allowed|available|permitted)|model.*access denied|unsupported model|model.*not found/.test(
      diagnostic,
    )
  )
    return "MODEL_ACCESS_FORBIDDEN";
  return "FORBIDDEN";
}

async function openRouterJson(
  config: LiveContentConfig,
  messages: Array<{
    role: "system" | "user";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        >;
  }>,
  webSearch = false,
): Promise<unknown> {
  const baseUrl = (
    config.openRouterTextBaseUrl ??
    config.openRouterBaseUrl ??
    "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
  const retryable = new Set([429, 500, 502, 503, 504]);
  const fallbackConfig = () => {
    const fallbacks = config.openRouterFallbackModels ?? [];
    const index = fallbacks.findIndex(
      (model) => model && model !== config.openRouterModel,
    );
    if (index < 0) return null;
    return {
      ...config,
      openRouterModel: fallbacks[index]!,
      openRouterFallbackModels: fallbacks.slice(index + 1),
    };
  };
  const useFallback = (
    fallback: LiveContentConfig,
    includeWebSearch = webSearch,
  ) => openRouterJson(fallback, messages, includeWebSearch);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://aiops.geekdance.cn",
          "X-Title": "GeekDance AI Operations",
        },
        body: JSON.stringify({
          model: config.openRouterModel,
          messages,
          response_format: { type: "json_object" },
          ...(config.openRouterProviderOrder?.length &&
          config.openRouterModel.startsWith("openai/")
            ? {
                provider: {
                  order: config.openRouterProviderOrder,
                  allow_fallbacks: true,
                },
              }
            : {}),
          ...(webSearch ? { plugins: [{ id: "web", max_results: 8 }] } : {}),
        }),
        signal: AbortSignal.timeout(config.openRouterTimeoutMs ?? 240_000),
      });
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("OpenRouter request failed");
      if (attempt === 3) {
        const fallback = fallbackConfig();
        if (fallback) return useFallback(fallback);
        throw lastError;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          750 * 2 ** attempt + Math.floor(Math.random() * 250),
        ),
      );
      continue;
    }
    if (response.ok) {
      const payload = (await response.json()) as Record<string, any>;
      await config.modelRecorder?.(
        typeof payload.model === "string"
          ? payload.model
          : config.openRouterModel,
      );
      const totalTokens = Math.max(0, Number(payload.usage?.total_tokens ?? 0));
      const costCents = Math.max(
        0,
        Math.round(Number(payload.usage?.cost ?? 0) * 100),
      );
      if (config.usageRecorder && (totalTokens || costCents))
        await config.usageRecorder({ totalTokens, costCents });
      return jsonContent(payload);
    }
    const detail = await classifyOpenRouterFailure(response, webSearch);
    lastError = new Error(`OPENROUTER_HTTP_${response.status}:${detail}`);
    const fallback = fallbackConfig();
    const explicitModelFailure = [
      "MODEL_ACCESS_FORBIDDEN",
      "PROVIDER_TOS_BLOCKED",
      "PROVIDER_UNAVAILABLE",
    ].includes(detail);

    // Preserve Web Search when a model or provider is explicitly blocked so a
    // compatible fallback can still build a current evidence list. Generic
    // 4xx responses are first retried on the same model without the plugin.
    if (webSearch && new Set([400, 403, 404]).has(response.status)) {
      if (fallback && explicitModelFailure) return useFallback(fallback);
      return openRouterJson(config, messages, false);
    }
    if (
      [403, 404].includes(response.status) &&
      (explicitModelFailure || detail === "FORBIDDEN") &&
      fallback
    ) {
      return useFallback(fallback);
    }
    if (!retryable.has(response.status)) throw lastError;
    if (attempt === 3) {
      if (fallback) return useFallback(fallback);
      throw lastError;
    }
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        retryAfter > 0
          ? Math.min(retryAfter * 1_000, 30_000)
          : 750 * 2 ** attempt + Math.floor(Math.random() * 250),
      ),
    );
  }
  throw lastError ?? new Error("OpenRouter request failed");
}

function openAiOutputText(payload: Record<string, any>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim())
    return payload.output_text;
  return arrayOf(payload.output)
    .flatMap((item: Record<string, any>) => arrayOf(item.content))
    .flatMap((item: Record<string, any>) =>
      item.type === "output_text" && typeof item.text === "string"
        ? [item.text]
        : [],
    )
    .join("");
}

async function openAiJson(
  config: LiveContentConfig,
  messages: Array<{
    role: "system" | "user";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        >;
  }>,
  webSearch = false,
  options: {
    jsonMode?: boolean;
    model?: string;
    researchFallbackTried?: boolean;
  } = {},
): Promise<unknown> {
  const baseUrl = (
    config.openRouterTextBaseUrl ?? "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const retryable = new Set([429, 500, 502, 503, 504]);
  const model = options.model ?? config.openRouterModel;
  // Hosted web search is invoked with ordinary text output. The research
  // prompt still requires JSON, which is parsed and validated downstream.
  const jsonMode = options.jsonMode ?? !webSearch;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: messages.map((message) => ({
            role: message.role,
            content:
              typeof message.content === "string"
                ? [{ type: "input_text", text: message.content }]
                : message.content.map((item) =>
                    item.type === "text"
                      ? { type: "input_text", text: item.text }
                      : {
                          type: "input_image",
                          image_url: item.image_url.url,
                        },
                  ),
          })),
          ...(webSearch ? { tools: [{ type: "web_search" }] } : {}),
          reasoning: {
            effort: config.openAiReasoningEffort ?? "medium",
          },
          ...(jsonMode ? { text: { format: { type: "json_object" } } } : {}),
          store: false,
        }),
        signal: AbortSignal.timeout(config.openRouterTimeoutMs ?? 240_000),
      });
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("OpenAI request failed");
      if (attempt === 3) throw lastError;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          750 * 2 ** attempt + Math.floor(Math.random() * 250),
        ),
      );
      continue;
    }
    if (response.ok) {
      const payload = (await response.json()) as Record<string, any>;
      await config.modelRecorder?.(
        typeof payload.model === "string" ? payload.model : model,
      );
      const totalTokens = Math.max(0, Number(payload.usage?.total_tokens ?? 0));
      if (config.usageRecorder && totalTokens)
        await config.usageRecorder({ totalTokens, costCents: 0 });
      const text = openAiOutputText(payload).trim();
      if (!text) throw new Error("OPENAI_RESPONSE_EMPTY_OUTPUT");
      return jsonContent({
        choices: [{ message: { content: text } }],
      });
    }
    const detail = await classifyOpenRouterFailure(response, webSearch);
    lastError = new Error(`OPENAI_HTTP_${response.status}:${detail}`);
    if (
      webSearch &&
      response.status === 400 &&
      detail === "WEB_SEARCH_UNAVAILABLE"
    ) {
      // Some Responses hosted-tool routes reject JSON mode even though the
      // same model can search and return JSON from prompt instructions.
      if (jsonMode)
        return openAiJson(config, messages, true, {
          ...options,
          jsonMode: false,
          model,
        });

      // Keep GPT-5.6 Sol for article writing. Only the evidence-gathering call
      // may use a search-capable official OpenAI model when Sol cannot invoke
      // the hosted web-search tool. Never continue research without search.
      const researchModel = config.openAiResearchFallbackModel?.trim();
      if (
        researchModel &&
        researchModel !== model &&
        !options.researchFallbackTried
      )
        return openAiJson(config, messages, true, {
          jsonMode: false,
          model: researchModel,
          researchFallbackTried: true,
        });
    }
    if (!retryable.has(response.status) || attempt === 3) throw lastError;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        retryAfter > 0
          ? Math.min(retryAfter * 1_000, 30_000)
          : 750 * 2 ** attempt + Math.floor(Math.random() * 250),
      ),
    );
  }
  throw lastError ?? new Error("OpenAI request failed");
}

function textModelJson(
  config: LiveContentConfig,
  messages: Parameters<typeof openRouterJson>[1],
  webSearch = false,
) {
  return config.textProvider === "openai"
    ? openAiJson(config, messages, webSearch)
    : openRouterJson(config, messages, webSearch);
}

const titleCandidatesSchema = z.object({
  titles: z.array(z.string().trim().min(4).max(120)).min(10).max(20),
});

export async function generateTitleCandidates(
  config: LiveContentConfig,
  input: {
    topic: string;
    targets: Channel[];
    readerMode: "general" | "professional";
    remarks?: string;
    contentType?: "general" | "case";
    sourceRefs?: string[];
    attachmentSummaries?: Array<{ name: string; text: string }>;
    primaryTag?: string;
    secondaryTags?: string[];
    count?: number;
  },
) {
  const count = Math.min(20, Math.max(10, input.count ?? 12));
  const limit = input.targets.includes("xiaohongshu")
    ? 20
    : input.targets.includes("wechat")
      ? 32
      : 120;
  const attachmentContext = (input.attachmentSummaries ?? [])
    .map((attachment) =>
      attachment.text
        ? `附件《${attachment.name}》：\n${attachment.text}`
        : `附件《${attachment.name}》（图片附件，仅可依据文件名判断主题，不得推断图中事实）`,
    )
    .join("\n\n")
    .slice(0, 48_000);
  const payload = await textModelJson(config, [
    {
      role: "system",
      content:
        "你是极客跳动资深内容编辑。生成准确、克制、具体、有信息量的中文文章标题。不得虚构案例、数据、客户或结果；不得使用夸张承诺、标题党、空泛问句或机械编号。只返回 JSON。",
    },
    {
      role: "user",
      content: `主题：${input.topic}\n内容类型：${input.contentType ?? "general"}\n渠道：${input.targets.join(",")}\n读者：${input.readerMode}\n一级标签：${input.primaryTag || "无"}\n二级标签：${(input.secondaryTags ?? []).join("、") || "无"}\n参考链接：${(input.sourceRefs ?? []).join("\n") || "无"}\n补充要求：${input.remarks || "无"}\n\n附件资料：\n${attachmentContext || "无"}\n\n先综合主题、链接、标签和附件中的明确事实，再生成 ${count} 个差异明显的候选标题，每个不超过 ${limit} 个字符。案例标题不得把方案写成已交付结果；图片附件不得凭空推断内容。兼顾业务价值、技术解释、趋势判断和行动导向，但标题必须被上述资料直接支持。返回 {"titles":[...]}。`,
    },
  ]);
  const parsed = titleCandidatesSchema.parse(payload);
  return [...new Set(parsed.titles)]
    .filter((title) => Array.from(title).length <= limit)
    .slice(0, count);
}

export async function generateCaseDiagramSpecs(
  config: LiveContentConfig,
  request: ContentJobRequest,
  evidence: EvidenceItem[],
  attachments: ResearchAttachment[],
) {
  if (request.contentType !== "case") return [];
  const requested = (request.caseVisualTypes ?? []).filter(
    (type) => type !== "cover",
  );
  if (!requested.length) throw new Error("CASE_DIAGRAM_TYPES_MISSING");
  let remainingCharacters = 120_000;
  const attachmentText = attachments.flatMap((attachment) => {
    if (!attachment.extractedText || remainingCharacters <= 0) return [];
    const text = attachment.extractedText.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    return [
      `附件 ID：${attachment.id}\n附件名称：${attachment.name}\n附件内容：\n${text}`,
    ];
  });
  if (!attachmentText.length)
    throw new Error("CASE_DIAGRAM_TEXT_SOURCE_MISSING");
  const messages: Parameters<typeof openRouterJson>[1] = [
    {
      role: "system",
      content: `你是极客跳动项目图事实整理器，严格执行 gd-biz-chart@1.0.0。只从用户附件和给定证据建立项目图规格。不得发明角色、步骤、技术栈、接口、数据库、云产品、供应商、经营数据或项目结果。架构材料未指定技术实现时只能使用“业务系统”“数据存储”“权限与日志”等中性名称。每个卡片必须填写真实 evidenceIds，sourceAttachmentIds 必须是实际使用的附件 UUID。只返回 JSON，不输出解释。\n\n目标结构：\n${CASE_DIAGRAM_JSON_CONTRACT}`,
    },
    {
      role: "user",
      content: `需要按此顺序生成项目图：${requested.join(", ")}\n案例状态：${request.caseStatus}\n主题：${request.topic}\n证据：${JSON.stringify(evidence)}\n附件：\n${attachmentText.join("\n\n")}\n为每种类型返回且只返回一份规格，顺序必须一致。function 按产品端与后台模块分组；flow 保留真实业务顺序；roles 保留附件角色名称；architecture 只写附件确认的系统层和集成。`,
    },
  ];
  const payload = await textModelJson(config, messages);
  try {
    return validateCaseDiagramSpecs(payload, request, evidence, attachments);
  } catch (error) {
    const validationDetails =
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          }))
        : error instanceof Error
          ? error.message
          : "UNKNOWN_VALIDATION_ERROR";
    const repairedPayload = await textModelJson(config, [
      messages[0]!,
      {
        role: "user",
        content: `首次返回没有通过项目图结构校验。只修复 JSON 结构与长度，不得新增、替换或扩写任何事实；只能使用下列 evidenceIds：${evidence.map((item) => item.id).join(", ")}；只能使用下列 sourceAttachmentIds：${attachments.map((item) => item.id).join(", ")}；必须严格按 ${requested.join(", ")} 的顺序各返回一份规格。\n校验错误：${JSON.stringify(validationDetails)}\n首次返回：${JSON.stringify(payload)}\n目标结构：\n${CASE_DIAGRAM_JSON_CONTRACT}`,
      },
    ]);
    return validateCaseDiagramSpecs(
      repairedPayload,
      request,
      evidence,
      attachments,
    );
  }
}

function parseRpc(text: string) {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : text) as Record<string, any>;
}

async function callGeekHome(
  config: LiveContentConfig,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await fetch(config.geekHomeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.geekHomeToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GEEKHOME_HTTP_${response.status}`);
  const rpc = parseRpc(await response.text());
  if (rpc.error) throw new Error(`GEEKHOME_RPC_${rpc.error.code ?? "UNKNOWN"}`);
  const contentText = rpc.result?.content?.find(
    (item: Record<string, unknown>) => item.type === "text",
  )?.text;
  return contentText ? JSON.parse(contentText) : rpc.result;
}

const arrayOf = (value: unknown) => (Array.isArray(value) ? value : []);
function materialUrl(item: Record<string, any>) {
  return [
    item.url,
    item.download_url,
    item.downloadUrl,
    item.file_url,
    item.fileUrl,
    item.preview_url,
    item.previewUrl,
    item.thumbnail_url,
    item.thumbnailUrl,
  ].find((url) => typeof url === "string" && /^https:\/\//i.test(url));
}
function normalizeMaterials(data: Record<string, any>): MaterialCandidate[] {
  const raw =
    [data.materials, data.items, data.data, data.results].find(Array.isArray) ??
    (data.material ? [data.material] : []);
  return raw.flatMap((item: Record<string, any>) => {
    const url = materialUrl(item);
    if (!url) return [];
    const rawUsageCount = Number(item.usageCount ?? item.usage_count ?? 0);
    return [
      {
        id: String(item.id ?? item.material_id ?? url),
        title: String(item.title ?? item.name ?? "GeekHome 素材"),
        url,
        primaryTag: item.primaryTag ?? item.primary_tag,
        secondaryTags: arrayOf(item.secondaryTags ?? item.secondary_tags).map(
          String,
        ),
        tags: [...arrayOf(item.tags), ...arrayOf(item.autoTags)].map(String),
        description: String(item.description ?? item.summary ?? ""),
        fileSizeBytes:
          Number(item.fileSize ?? item.file_size ?? item.size ?? 0) ||
          undefined,
        usageCount: Number.isFinite(rawUsageCount) ? rawUsageCount : 0,
        authorized:
          item.authorized === true || item.authorization_status === "approved",
        containsPerson:
          item.containsPerson === true ||
          item.contains_person === true ||
          /合照|合影|客户的故事|上门拜访|见面会|团队照/.test(
            `${item.title ?? ""} ${item.primaryTag ?? item.primary_tag ?? ""} ${arrayOf(item.secondaryTags ?? item.secondary_tags).join(" ")} ${arrayOf(item.tags).join(" ")}`,
          ),
      },
    ];
  });
}

export function createLivePorts(config: LiveContentConfig): ContentEnginePorts {
  if (!config.openRouterApiKey)
    throw new Error(
      config.textProvider === "openai"
        ? "Live OpenAI content mode requires an OpenAI credential"
        : "Live OpenRouter content mode requires an OpenRouter credential",
    );
  return {
    async research(
      request: ContentJobRequest,
      attachments: ResearchAttachment[],
    ): Promise<EvidenceItem[]> {
      let remainingCharacters = 120_000;
      const attachmentText = attachments.flatMap((attachment) => {
        if (!attachment.extractedText || remainingCharacters <= 0) return [];
        const text = attachment.extractedText.slice(0, remainingCharacters);
        remainingCharacters -= text.length;
        return [
          `附件 ID：${attachment.id}\n附件名称：${attachment.name}\n附件内容：\n${text}`,
        ];
      });
      const userContent: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [
        {
          type: "text",
          text: `为以下主题建立证据清单：${request.topic}\n用户提供来源：${request.sourceRefs.join("\n") || "无"}\n${attachmentText.length ? `用户附件：\n${attachmentText.join("\n\n")}` : "用户附件：无"}\n严格返回符合以下结构的 json：\n${evidenceJsonContract}\n附件证据的 URL 必须写为 https://aiops.geekdance.cn/internal/attachments/附件ID。`,
        },
        ...attachments.flatMap((attachment) =>
          attachment.dataUrl
            ? [
                {
                  type: "image_url" as const,
                  image_url: { url: attachment.dataUrl },
                },
              ]
            : [],
        ),
      ];
      const payload = await textModelJson(
        config,
        [
          {
            role: "system",
            content:
              "你是企业内容事实核验员。只采用一手公开来源、权威来源、用户明确提供的链接和内部资料。输出纯 json，禁止虚构 URL、来源标题、数字或结论。",
          },
          {
            role: "user",
            content: userContent,
          },
        ],
        true,
      );
      const normalized = normalizeEvidencePayload(payload);
      const parsed = evidenceResponseSchema.safeParse(normalized);
      let evidence: EvidenceItem[];
      if (parsed.success) {
        evidence = parsed.data.evidence;
      } else {
        const repaired = normalizeEvidencePayload(
          await textModelJson(config, [
            {
              role: "system",
              content: `你是 json 结构修复器。只修复字段名、字段类型、数组层级和时间格式，不新增来源、URL、事实、数字或结论，不输出解释、Markdown 或 HTML。\n\n目标结构：\n${evidenceJsonContract}`,
            },
            {
              role: "user",
              content: `当前结构错误：${JSON.stringify(compactSchemaIssues(parsed.error))}\n待修复对象：${JSON.stringify(payload)}\n只返回修复后的 json 对象。`,
            },
          ]),
        );
        const repairedParsed = evidenceResponseSchema.safeParse(repaired);
        if (!repairedParsed.success)
          throw new Error("EVIDENCE_OUTPUT_SCHEMA_INVALID", {
            cause: repairedParsed.error,
          });
        evidence = repairedParsed.data.evidence;
      }
      const ids = new Set(evidence.map((item) => item.id));
      if (ids.size !== evidence.length)
        throw new Error("EVIDENCE_IDS_MUST_BE_UNIQUE");
      const attachmentIds = new Set(attachments.map((item) => item.id));
      for (const item of evidence) {
        if (item.sourceType === "mock")
          throw new Error("MOCK_EVIDENCE_FORBIDDEN_IN_LIVE_MODE");
        if (item.sourceType === "user_attachment") {
          const match = item.url.match(/\/internal\/attachments\/([^/?#]+)$/);
          if (!match || !attachmentIds.has(match[1]!))
            throw new Error("EVIDENCE_ATTACHMENT_REFERENCE_INVALID");
        }
      }
      return evidence;
    },
    async write(
      request: ContentJobRequest,
      evidence: EvidenceItem[],
      channel: Channel,
      revisionNotes: string[] = [],
      attachments: ResearchAttachment[] = [],
    ): Promise<CoreArticle> {
      const template = getChannelTemplate(channel, request.contentType);
      let remainingAttachmentCharacters =
        request.contentType === "case" ? 100_000 : 20_000;
      const attachmentContext = attachments.flatMap((attachment) => {
        if (!attachment.extractedText || remainingAttachmentCharacters <= 0)
          return [];
        const content = attachment.extractedText.slice(
          0,
          remainingAttachmentCharacters,
        );
        remainingAttachmentCharacters -= content.length;
        return [`附件：${attachment.name}\n${content}`];
      });
      const payload = await textModelJson(config, [
        {
          role: "system",
          content: `你正在严格执行 ${template.skillName}@${template.version}。以下是已审核并随代码发布的 Skill 写作与质检快照。只负责生成渠道专属 CoreArticle json；检索、排版、图片上传和草稿写入由网站的确定性程序完成，不要输出工具调用或 HTML。\n\n${template.writingInstructions}\n\n当前商业编辑方向（优先于模板中的泛化表达）：\n${COMMERCIAL_EDITORIAL_DIRECTION}\n\n必须严格遵循以下 json 结构：\n${coreArticleJsonContract}`,
        },
        {
          role: "user",
          content: `目标渠道：${channelLabels[channel]}\n内容类型：${request.contentType === "case" ? "项目案例" : "通识文章"}\n案例事实状态：${request.caseStatus === "proposal" ? "方案型案例，禁止写成已上线或已取得成效" : request.caseStatus === "delivered" ? "已交付案例，但结果表述仍必须有验收、上线或数据证据" : "不适用"}\n主题：${request.topic}\n标题：${request.title || "自动生成"}\n读者模式：${request.readerMode}\n补充要求：${request.remarks || "无"}\n证据：${JSON.stringify(evidence)}\n${attachmentContext.length ? `项目附件原文（只可提取其中明确内容）：\n${attachmentContext.join("\n\n")}` : "项目附件原文：无"}\n修订要求：${revisionNotes.join("；") || "无"}\n请为该渠道独立创作，不要复用其他渠道的正文。只返回一个符合上述结构的 json 对象。所有事实必须映射到 evidenceIds；conclusion 必须是 12-62 字的完整独立句；cta 必须是 10-42 字、可单独成立的完整行动建议，禁止只写“如果/若/当……”条件从句；两个字段都必须带结束标点。公众号摘要不得超过 128 字，官网正文不得附加公众号宣传板；小红书采用短段落、具体场景和自然表达；知乎以问题论证和边界解释为主；今日头条开场直接且适合移动阅读；百家号结构清楚并自然包含业务检索词。禁止虚构个人体验、客户案例或效果数据。`,
        },
      ]);
      const normalized = normalizeCoreArticlePayload(payload);
      const parsed = coreArticleSchema.safeParse(normalized);
      if (parsed.success) return parsed.data;

      const repairedPayload = await textModelJson(config, [
        {
          role: "system",
          content: `你是 json 结构修复器。只修复字段名、字段类型、数组层级和缺失的结构字段，不改写文章观点，不增加事实，不增加证据，不输出解释、Markdown 或 HTML。\n\n目标结构：\n${coreArticleJsonContract}`,
        },
        {
          role: "user",
          content: `允许使用的 evidenceIds：${JSON.stringify(evidence.map((item) => item.id))}\n当前结构错误：${JSON.stringify(compactSchemaIssues(parsed.error))}\n待修复对象：${JSON.stringify(payload)}\n只返回修复后的 json 对象。`,
        },
      ]);
      const repaired = coreArticleSchema.safeParse(
        normalizeCoreArticlePayload(repairedPayload, {
          completeSections: true,
        }),
      );
      if (!repaired.success)
        throw new Error("ARTICLE_OUTPUT_SCHEMA_INVALID", {
          cause: repaired.error,
        });
      return repaired.data;
    },
    async searchMaterials(request: ContentJobRequest) {
      return searchGeekHomeMaterials(config, request);
    },
    async generateImages(request, article, evidence, attachments, onProgress) {
      if (!config.imageGenerator)
        throw new Error("Live content image generator is not configured");
      return config.imageGenerator(
        request,
        article,
        evidence,
        attachments,
        onProgress,
      );
    },
  };
}

export async function searchGeekHomeMaterials(
  config: GeekHomeConfig,
  request: ContentJobRequest,
) {
  if (!config.geekHomeUrl || !config.geekHomeToken)
    throw new Error("GeekHome credentials are required");
  const calls: Array<Promise<Record<string, any>>> = [];
  if (request.primaryTag || request.secondaryTags?.length)
    calls.push(
      callGeekHome(config as LiveContentConfig, "get_materials_by_tags", {
        primaryTag: request.primaryTag,
        secondaryTags: request.secondaryTags,
        match: "any",
        limit: 30,
      }),
    );
  const fullQuery = `${request.title ?? ""} ${request.topic}`.trim();
  const queries = [
    ...new Set(
      [
        fullQuery,
        request.primaryTag,
        ...(request.secondaryTags ?? []),
        ...(fullQuery.match(/[A-Za-z][A-Za-z0-9-]{1,20}/g) ?? []),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const query of queries.slice(0, 6))
    calls.push(
      callGeekHome(config as LiveContentConfig, "search_materials", {
        query,
        type: "image",
        limit: 30,
      }),
    );
  const settled = await Promise.allSettled(calls);
  const results = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (!results.length) {
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw failure?.reason instanceof Error
      ? failure.reason
      : new Error("GeekHome material search failed");
  }
  const materials = results.flatMap(normalizeMaterials);
  return [
    ...new Map(materials.map((item) => [item.id ?? item.url, item])).values(),
  ];
}
