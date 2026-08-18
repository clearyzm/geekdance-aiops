import type {
  CaseVisualType,
  ContentJobRequest,
  EvidenceItem,
  ResearchAttachment,
} from "@geekdance/shared";
import { z } from "zod";

const diagramTypeSchema = z.enum(["function", "flow", "roles", "architecture"]);

export const caseDiagramSpecSchema = z.object({
  diagramType: diagramTypeSchema,
  projectName: z.string().trim().min(2).max(40),
  title: z.string().trim().min(2).max(48),
  subtitle: z.string().trim().min(2).max(80),
  sequence: z.array(z.string().trim().min(1).max(16)).max(8).default([]),
  modules: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(18),
        items: z.array(z.string().trim().min(1).max(24)).min(1).max(4),
        evidenceIds: z.array(z.string().trim().min(1)).min(1).max(4),
      }),
    )
    .min(3)
    .max(10),
  supports: z.array(z.string().trim().min(1).max(20)).max(8).default([]),
  sourceAttachmentIds: z.array(z.string().uuid()).min(1).max(10),
});

export const caseDiagramSpecsSchema = z.object({
  specs: z.array(caseDiagramSpecSchema).min(1).max(4),
});

export type CaseDiagramSpec = z.infer<typeof caseDiagramSpecSchema>;

function limitModelGeneratedCollections(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.specs)) return value;
  const limitedText = (candidate: unknown, maximum: number) =>
    typeof candidate === "string"
      ? Array.from(candidate.trim()).slice(0, maximum).join("")
      : candidate;
  return {
    ...root,
    specs: root.specs.slice(0, 4).map((candidate) => {
      if (!candidate || typeof candidate !== "object") return candidate;
      const spec = candidate as Record<string, unknown>;
      return {
        ...spec,
        projectName: limitedText(spec.projectName, 40),
        title: limitedText(spec.title, 48),
        subtitle: limitedText(spec.subtitle, 80),
        sequence: Array.isArray(spec.sequence)
          ? spec.sequence.slice(0, 8).map((item) => limitedText(item, 16))
          : spec.sequence,
        modules: Array.isArray(spec.modules)
          ? spec.modules.slice(0, 10).map((candidateModule) => {
              if (!candidateModule || typeof candidateModule !== "object")
                return candidateModule;
              const module = candidateModule as Record<string, unknown>;
              return {
                ...module,
                title: limitedText(module.title, 18),
                items: Array.isArray(module.items)
                  ? module.items
                      .slice(0, 4)
                      .map((item) => limitedText(item, 24))
                  : module.items,
                evidenceIds: Array.isArray(module.evidenceIds)
                  ? module.evidenceIds.slice(0, 4)
                  : module.evidenceIds,
              };
            })
          : spec.modules,
        supports: Array.isArray(spec.supports)
          ? spec.supports.slice(0, 8).map((item) => limitedText(item, 20))
          : spec.supports,
        sourceAttachmentIds: Array.isArray(spec.sourceAttachmentIds)
          ? spec.sourceAttachmentIds.slice(0, 10)
          : spec.sourceAttachmentIds,
      };
    }),
  };
}

export const CASE_DIAGRAM_JSON_CONTRACT = `{
  "specs": [{
    "diagramType": "function|flow|roles|architecture",
    "projectName": "附件中的项目名称",
    "title": "项目图标题",
    "subtitle": "附件可支持的一句话定位",
    "sequence": ["仅当附件确认顺序时填写"],
    "modules": [{
      "title": "模块、角色、阶段或层级名称",
      "items": ["1至4条附件原文可支持的短语"],
      "evidenceIds": ["支持该卡片的真实 evidence id"]
    }],
    "supports": ["附件确认的支撑能力或价值"],
    "sourceAttachmentIds": ["实际使用的附件 UUID"]
  }]
}`;

export function validateCaseDiagramSpecs(
  value: unknown,
  request: ContentJobRequest,
  evidence: EvidenceItem[],
  attachments: ResearchAttachment[],
) {
  const parsed = caseDiagramSpecsSchema.parse(
    limitModelGeneratedCollections(value),
  );
  const requested = (request.caseVisualTypes ?? []).filter(
    (type): type is Exclude<CaseVisualType, "cover"> => type !== "cover",
  );
  if (
    parsed.specs.length !== requested.length ||
    parsed.specs.some((spec, index) => spec.diagramType !== requested[index])
  )
    throw new Error("CASE_DIAGRAM_TYPES_MISMATCH");
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const attachmentIds = new Set(attachments.map((item) => item.id));
  for (const spec of parsed.specs) {
    if (
      spec.sourceAttachmentIds.some((id) => !attachmentIds.has(id)) ||
      spec.modules.some((module) =>
        module.evidenceIds.some((id) => !evidenceIds.has(id)),
      )
    )
      throw new Error("CASE_DIAGRAM_EVIDENCE_INVALID");
  }
  return parsed.specs;
}
