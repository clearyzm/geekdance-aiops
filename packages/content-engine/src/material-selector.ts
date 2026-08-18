import { createHash } from "node:crypto";

export type MaterialCandidate = {
  id?: string;
  title?: string;
  url?: string;
  primaryTag?: string;
  secondaryTags?: string[];
  tags?: string[];
  description?: string;
  fileSizeBytes?: number;
  usageCount?: number;
  authorized?: boolean;
  containsPerson?: boolean;
};

type SelectInput = {
  topic: string;
  title: string;
  targetPlatform:
    | "official_site"
    | "wechat"
    | "xiaohongshu"
    | "zhihu"
    | "toutiao"
    | "baijiahao"
    | "linkedin";
  primaryTag?: string;
  secondaryTags?: string[];
  imageIntent: "cover" | "inline";
  operationId: string;
  candidates: MaterialCandidate[];
};

const norm = (value?: string) => (value ?? "").trim().toLowerCase();
// Keep a margin below the official-site uploader's 10 MiB hard limit. GeekHome
// returns source sizes, so oversized candidates should never reach upload time.
const MAX_UPLOAD_SAFE_BYTES = 9.5 * 1024 * 1024;
const tagsOf = (material: MaterialCandidate) => [
  ...new Set(
    [
      material.primaryTag,
      ...(material.secondaryTags ?? []),
      ...(material.tags ?? []),
    ]
      .filter(Boolean)
      .map((tag) => norm(tag)),
  ),
];

function seededNoise(seed: string, identity: string) {
  return (
    Number.parseInt(
      createHash("sha1")
        .update(`${seed}:${identity}`)
        .digest("hex")
        .slice(0, 8),
      16,
    ) / 0xffffffff
  );
}

export function selectMaterial(input: SelectInput) {
  const primary = norm(input.primaryTag || input.secondaryTags?.[0]);
  const secondary = (input.secondaryTags ?? []).map(norm);
  const terms = [
    ...new Set(
      `${input.topic} ${input.title}`
        .split(/[\s，。、“”：《》【】（）()|/\\-]+/)
        .map(norm)
        .filter((term) => term.length >= 2),
    ),
  ];
  const ranked = input.candidates
    .flatMap((material) => {
      if (!material.url || !/^https?:\/\//i.test(material.url)) return [];
      if (
        Number.isFinite(material.fileSizeBytes) &&
        (material.fileSizeBytes as number) > MAX_UPLOAD_SAFE_BYTES
      )
        return [];
      const identity =
        material.id || createHash("sha1").update(material.url).digest("hex");
      const tags = tagsOf(material);
      const text = norm(
        `${material.title ?? ""} ${material.description ?? ""} ${tags.join(" ")}`,
      );
      let score = 0;
      const reasons: string[] = [];
      for (const tag of secondary)
        if (tag && tags.includes(tag)) {
          score += 80;
          reasons.push(`二级标签匹配：${tag}`);
        }
      if (primary && tags.includes(primary)) {
        score += 60;
        reasons.push(`一级标签匹配：${primary}`);
      }
      for (const tag of tags) {
        if (
          tag &&
          !secondary.includes(tag) &&
          tag !== primary &&
          terms.some((term) => tag.includes(term) || term.includes(tag))
        ) {
          score += 30;
          if (reasons.length < 6) reasons.push(`通用标签匹配：${tag}`);
        }
      }
      for (const term of terms)
        if (text.includes(term)) {
          score += 8;
          if (reasons.length < 6) reasons.push(`语义匹配：${term}`);
        }
      if (
        input.targetPlatform === "official_site" &&
        /官网|博客|封面|科技|品牌|海报/.test(text)
      )
        score += 15;
      if (
        input.targetPlatform === "wechat" &&
        /公众号|封面|品牌|活动/.test(text)
      )
        score += 10;
      if (
        input.targetPlatform === "xiaohongshu" &&
        /小红书|竖版|3:4|封面|组图|社交/.test(text)
      )
        score += 12;
      return [
        {
          material,
          identity,
          score,
          usageCount: material.usageCount ?? 0,
          reasons,
          noise: seededNoise(input.operationId, identity),
        },
      ];
    })
    .filter((item) => item.score >= 30)
    .sort(
      (a, b) =>
        b.score - a.score || a.usageCount - b.usageCount || a.noise - b.noise,
    );

  if (!ranked.length)
    return {
      selected: null,
      rankedCandidates: [],
      manualReview: true,
      reason: "没有达到相关性阈值的 GeekHome 素材",
    };
  const topScore = ranked[0]!.score;
  const relevant = ranked.filter(
    (item) => item.score >= Math.max(30, topScore * 0.8),
  );
  const lowestUsage = Math.min(...relevant.map((item) => item.usageCount));
  const fairPool = relevant
    .filter((item) => item.usageCount === lowestUsage)
    .sort((a, b) => a.noise - b.noise);
  const selected = fairPool[0]!;
  return {
    selected: selected.material,
    selectedIdentity: selected.identity,
    usageCountBefore: selected.usageCount,
    score: selected.score,
    selectionReason: `${selected.reasons.join("；")}；同等相关素材中优先使用次数 ${selected.usageCount}`,
    manualReview: false,
    reason: "",
    rankedCandidates: ranked
      .slice(0, 10)
      .map(({ material, score, usageCount, reasons }) => ({
        id: material.id,
        title: material.title,
        score,
        usageCount,
        reasons,
      })),
  };
}
