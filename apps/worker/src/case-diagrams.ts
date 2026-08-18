import { readFile } from "node:fs/promises";
import type { CoreArticle } from "@geekdance/shared";
import type { CaseDiagramSpec } from "@geekdance/content-engine";
import sharp from "sharp";
import {
  applyGeneratedImageTypography,
  GENERATED_IMAGE_FONT_FAMILY,
  renderGeneratedImageSvg,
} from "./svg-renderer.js";

const RED = "#E60012";
const DEEP_RED = "#B90012";
const SOFT_RED = "#FFF1F2";
const BORDER = "#F4B9BF";
const INK = "#17171A";
const MUTED = "#666A73";
const normalizedFontWeight = (weight: number) => (weight >= 600 ? 700 : 400);

const escapeXml = (value: string) =>
  value.replace(
    /[&<>\"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  weight = 400,
  fill = INK,
  anchor = "start",
) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${normalizedFontWeight(weight)}" fill="${fill}" text-anchor="${anchor}" font-family="${GENERATED_IMAGE_FONT_FAMILY}">${escapeXml(value)}</text>`;
}

function wrappedLines(value: string, maximum = 13) {
  const normalized = value.trim();
  const result: string[] = [];
  for (let index = 0; index < normalized.length; index += maximum)
    result.push(normalized.slice(index, index + maximum));
  return result.length ? result : [""];
}

function multiline(
  x: number,
  y: number,
  value: string,
  maximum: number,
  size: number,
  lineHeight: number,
  weight = 400,
  fill = INK,
  anchor = "start",
  maximumLines = 2,
) {
  return wrappedLines(value, maximum)
    .slice(0, maximumLines)
    .map((line, index) =>
      text(x, y + index * lineHeight, line, size, weight, fill, anchor),
    )
    .join("");
}

function wrapByVisualUnits(value: string, maximumUnits: number) {
  const lines: string[] = [];
  let line = "";
  let units = 0;
  for (const character of Array.from(value.trim())) {
    const characterUnits = /^[\u0000-\u00ff]$/u.test(character) ? 0.58 : 1;
    if (line && units + characterUnits > maximumUnits) {
      lines.push(line.trim());
      line = "";
      units = 0;
    }
    line += character;
    units += characterUnits;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [""];
}

function measureVisualUnits(value: string) {
  return Array.from(value).reduce(
    (sum, character) => sum + (/^[\u0000-\u00ff]$/u.test(character) ? 0.58 : 1),
    0,
  );
}

function fittedTextBox(
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  options: {
    maxSize?: number;
    minSize?: number;
    maxLines?: number;
    weight?: number;
    fill?: string;
    align?: "start" | "middle";
  } = {},
) {
  const maxSize = options.maxSize ?? 30;
  const minSize = options.minSize ?? 13;
  const maxLines = options.maxLines ?? 4;
  let fontSize = maxSize;
  let lines = [value];
  let fitted = false;
  for (; fontSize >= minSize; fontSize -= 1) {
    const maximumUnits = Math.max(2, width / (fontSize * 1.02));
    lines = wrapByVisualUnits(value, maximumUnits);
    const lineHeight = fontSize * 1.28;
    if (lines.length <= maxLines && lines.length * lineHeight <= height) {
      fitted = true;
      break;
    }
  }
  if (!fitted) {
    fontSize = Math.max(
      1,
      Math.min(
        minSize,
        height / (maxLines * 1.28),
        (width * maxLines) / (Math.max(1, measureVisualUnits(value)) * 1.08),
      ),
    );
    lines = wrapByVisualUnits(value, Math.max(2, width / (fontSize * 1.02)));
  }
  const lineHeight = fontSize * 1.28;
  const totalHeight = lines.length * lineHeight;
  const textX = options.align === "start" ? x : x + width / 2;
  const anchor = options.align === "start" ? "start" : "middle";
  const startY = y + Math.max(fontSize, (height - totalHeight) / 2 + fontSize);
  return lines
    .map(
      (line, index) =>
        `<text data-exact-copy="${escapeXml(value)}" x="${textX}" y="${startY + index * lineHeight}" font-size="${fontSize}" font-weight="${normalizedFontWeight(options.weight ?? 400)}" fill="${options.fill ?? INK}" text-anchor="${anchor}" font-family="${GENERATED_IMAGE_FONT_FAMILY}">${escapeXml(line)}</text>`,
    )
    .join("");
}

export function caseCoverTitleLines(value: string, maximum = 9) {
  const normalized = value.trim();
  const colonIndex = normalized.lastIndexOf("：");
  const suffix = colonIndex >= 0 ? normalized.slice(colonIndex + 1).trim() : "";
  const displayTitle =
    suffix.replace(/\s/gu, "").length >= 8 ? suffix : normalized;
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const units: Array<{ text: string; leadingSpace: boolean }> = [];
  let pendingSpace = false;

  for (const part of displayTitle.split(/(\s+)/u)) {
    if (!part) continue;
    if (/^\s+$/u.test(part)) {
      pendingSpace = units.length > 0;
      continue;
    }
    for (const segment of segmenter.segment(part)) {
      units.push({ text: segment.segment, leadingSpace: pendingSpace });
      pendingSpace = false;
    }
  }

  const unitWidth = (unit: { text: string; leadingSpace: boolean }) =>
    unit.text.length + (unit.leadingSpace ? 1 : 0);
  const rows: Array<Array<{ text: string; leadingSpace: boolean }>> = [];
  let row: Array<{ text: string; leadingSpace: boolean }> = [];
  let rowWidth = 0;
  for (const unit of units) {
    const width = unitWidth(unit);
    if (row.length && rowWidth + width > maximum) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push({ ...unit, leadingSpace: row.length > 0 && unit.leadingSpace });
    rowWidth += width;
  }
  if (row.length) rows.push(row);

  if (rows.length === 3) {
    const tailWidth = rows[2]!.reduce((sum, unit) => sum + unitWidth(unit), 0);
    if (tailWidth < 4 && rows[1]!.length > 1) {
      const moved = rows[1]!.pop()!;
      rows[2]!.unshift({ ...moved, leadingSpace: false });
    }
  }

  return rows.slice(0, 3).map((line) =>
    line
      .map((unit) => `${unit.leadingSpace ? " " : ""}${unit.text}`)
      .join("")
      .trim(),
  );
}

function coverTitleText(x: number, y: number, value: string) {
  return caseCoverTitleLines(value)
    .map((line, index) => text(x, y + index * 112, line, 92, 880, "#FFFFFF"))
    .join("");
}

function dataUri(bytes: Buffer, mimeType = "image/png") {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function brandBadge(logo: string, x: number, y: number, width: number) {
  return `<rect x="${x}" y="${y}" width="${width}" height="88" rx="22" fill="#FFFFFF" stroke="${BORDER}"/><image href="${logo}" x="${x + 18}" y="${y + 14}" width="${width - 36}" height="60" preserveAspectRatio="xMidYMid meet"/>`;
}

export function caseCoverHeroVariant(title: string, description = "") {
  const context = `${title} ${description}`;
  if (/房产|房源|置业|宅邸|楼盘|住宅/u.test(context)) return "real_estate";
  return "project_system";
}

function fallbackCaseHeroDetails(title: string, description: string) {
  if (caseCoverHeroVariant(title, description) !== "real_estate") return "";
  return `<g transform="translate(300 950) rotate(-7 500 520)"><rect x="-10" y="-10" width="1040" height="920" rx="68" fill="#08090B" stroke="#08090B" stroke-width="24"/><ellipse cx="520" cy="520" rx="440" ry="400" fill="${RED}" opacity=".2"/><g filter="url(#coverShadow)" transform="rotate(12 510 450)"><rect x="250" y="-80" width="520" height="1060" rx="86" fill="#F7F7F8" stroke="#FFFFFF" stroke-width="12"/><rect x="274" y="-52" width="472" height="1004" rx="62" fill="#111217"/><rect x="418" y="-27" width="184" height="42" rx="21" fill="#050507"/><circle cx="688" cy="-6" r="9" fill="${RED}"/><rect x="274" y="48" width="472" height="116" fill="#111217"/>${text(310, 114, "AI 房产顾问", 28, 760, "#FFFFFF")}<circle cx="698" cy="106" r="22" fill="${RED}"/><path d="m687 106 8 8 16-20" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><rect x="294" y="164" width="432" height="334" rx="32" fill="#202126"/><circle cx="642" cy="232" r="74" fill="${RED}" opacity=".17"/><path d="M338 428V302l92-76 92 76v126M397 428v-92h66v92" fill="none" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/><path d="M554 428V280h112v148M580 318h22m30 0h16m-68 52h22m30 0h16" fill="none" stroke="${RED}" stroke-width="16" stroke-linecap="round"/><path d="M668 224c-34 0-62 27-62 60 0 46 62 102 62 102s62-56 62-102c0-33-28-60-62-60Z" fill="#FFFFFF"/><circle cx="668" cy="284" r="20" fill="${RED}"/><rect x="274" y="498" width="472" height="454" fill="#F7F7F8"/><rect x="300" y="528" width="420" height="92" rx="28" fill="#FFFFFF" stroke="#E0E0E4" stroke-width="3"/><circle cx="346" cy="574" r="23" fill="${RED}"/>${text(388, 584, "需求匹配", 25, 720, "#17181D")}<path d="m650 566 13 13 25-31" fill="none" stroke="${RED}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="300" y="644" width="198" height="182" rx="28" fill="#17181D"/><path d="M332 744v-42l66-52 66 52v42M374 744v-46h48v46" fill="none" stroke="#FFFFFF" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>${text(340, 794, "房源推荐", 20, 650, "#FFFFFF")}<rect x="522" y="644" width="198" height="182" rx="28" fill="${RED}"/><path d="M558 696h112a18 18 0 0 1 18 18v28a18 18 0 0 1-18 18h-58l-30 24 7-24h-31a18 18 0 0 1-18-18v-28a18 18 0 0 1 18-18Z" fill="#FFFFFF"/><circle cx="588" cy="728" r="7" fill="${RED}"/><circle cx="615" cy="728" r="7" fill="${RED}"/><circle cx="642" cy="728" r="7" fill="${RED}"/>${text(550, 804, "顾问服务", 20, 650, "#FFFFFF")}<rect x="374" y="878" width="272" height="12" rx="6" fill="#17181D" opacity=".84"/></g></g>`;
}

function moduleCard(
  module: CaseDiagramSpec["modules"][number],
  x: number,
  y: number,
  width: number,
  height: number,
  index: number,
) {
  let svg = `<g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="#FFFFFF" stroke="${BORDER}" stroke-width="2"/></g>`;
  svg += `<rect x="${x}" y="${y}" width="${width}" height="68" rx="24" fill="url(#redGradient)"/><rect x="${x}" y="${y + 48}" width="${width}" height="20" fill="${RED}"/>`;
  svg += `<circle cx="${x + 42}" cy="${y + 34}" r="22" fill="#FFFFFF" opacity=".96"/>${text(x + 42, y + 42, String(index), 20, 800, RED, "middle")}`;
  svg += multiline(
    x + 82,
    y + 42,
    module.title,
    15,
    23,
    28,
    750,
    "#FFFFFF",
    "start",
    1,
  );
  const items = module.items.slice(0, 4);
  const itemStep = Math.min(
    86,
    Math.max(48, Math.floor((height - 112) / Math.max(1, items.length))),
  );
  const itemWidth = width > 600 ? 25 : 16;
  let itemY = y + 116;
  for (const item of items) {
    const lines = wrappedLines(item, itemWidth).slice(0, 2);
    svg += `<circle cx="${x + 34}" cy="${itemY - 7}" r="5" fill="${RED}"/>`;
    for (const [lineIndex, line] of lines.entries())
      svg += text(x + 54, itemY + lineIndex * 30, line, 20, 450, "#4D515A");
    itemY += Math.max(itemStep, lines.length * 30 + 16);
  }
  return svg;
}

export async function renderCaseDiagram(
  spec: CaseDiagramSpec,
  options: { logoPath: string; mascotPath: string },
) {
  const [logoBytes, mascotBytes] = await Promise.all([
    readFile(options.logoPath),
    readFile(options.mascotPath),
  ]);
  const logo = dataUri(logoBytes);
  const mascot = dataUri(mascotBytes);
  const width = 1620;
  const height = 2160;
  const columns = spec.modules.length <= 4 ? 2 : 3;
  const gap = 18;
  const cardWidth = (1476 - gap * (columns - 1)) / columns;
  const rows = Math.ceil(spec.modules.length / columns);
  const cardHeight = Math.min(
    spec.diagramType === "architecture" ? 650 : 680,
    Math.floor((1420 - gap * (rows - 1)) / Math.max(1, rows)),
  );
  const sequence = spec.sequence.slice(0, 8);
  const cardsStartY = sequence.length ? 560 : 420;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="redGradient" x1="0" x2="1"><stop stop-color="${RED}"/><stop offset="1" stop-color="${DEEP_RED}"/></linearGradient><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#A20B18" flood-opacity=".1"/></filter></defs><rect width="${width}" height="${height}" fill="#FFFDFC"/><rect width="${width}" height="16" fill="url(#redGradient)"/>`;
  svg += brandBadge(logo, 72, 46, 286);
  svg += multiline(72, 210, spec.title, 24, 48, 58, 820, INK, "start", 2);
  svg += multiline(72, 286, spec.subtitle, 42, 24, 32, 420, MUTED, "start", 2);
  svg += `<path d="M72 330H1548" stroke="${BORDER}" stroke-width="2" stroke-dasharray="8 10"/>`;
  if (sequence.length) {
    svg += text(72, 388, "01  核心逻辑", 30, 750, RED);
    const sequenceGap = 10;
    const sequenceWidth =
      (1476 - sequenceGap * (sequence.length - 1)) / sequence.length;
    for (const [index, item] of sequence.entries()) {
      const x = 72 + index * (sequenceWidth + sequenceGap);
      svg += `<rect x="${x}" y="414" width="${sequenceWidth}" height="78" rx="16" fill="${index === sequence.length - 1 ? "url(#redGradient)" : SOFT_RED}" stroke="${BORDER}"/>`;
      svg += multiline(
        x + sequenceWidth / 2,
        456,
        item,
        8,
        17,
        21,
        650,
        index === sequence.length - 1 ? "#FFFFFF" : INK,
        "middle",
        2,
      );
    }
  }
  svg += text(72, cardsStartY - 28, "02  项目内容", 30, 750, RED);
  for (const [index, module] of spec.modules.entries()) {
    const isSingleLast =
      index === spec.modules.length - 1 && spec.modules.length % columns === 1;
    const column = isSingleLast ? 1 : index % columns;
    const x = 72 + column * (cardWidth + gap);
    const y = cardsStartY + Math.floor(index / columns) * (cardHeight + gap);
    svg += moduleCard(module, x, y, cardWidth, cardHeight, index + 1);
  }
  const cardsBottom =
    cardsStartY + rows * cardHeight + Math.max(0, rows - 1) * gap;
  const supportY = Math.min(1905, cardsBottom + 66);
  svg += text(72, supportY, "03  支撑与价值", 30, 750, RED);
  const supports = spec.supports.slice(0, 8);
  const supportColumns = Math.min(4, Math.max(1, supports.length));
  const supportWidth = (1476 - 14 * (supportColumns - 1)) / supportColumns;
  for (const [index, item] of supports.entries()) {
    const x = 72 + (index % supportColumns) * (supportWidth + 14);
    const y = supportY + 28 + Math.floor(index / supportColumns) * 62;
    svg += `<rect x="${x}" y="${y}" width="${supportWidth}" height="48" rx="14" fill="#FFFFFF" stroke="${BORDER}"/><circle cx="${x + 23}" cy="${y + 24}" r="6" fill="${RED}"/>`;
    svg += multiline(x + 40, y + 31, item, 18, 17, 20, 520, INK, "start", 1);
  }
  svg += `<rect x="72" y="2048" width="1120" height="84" rx="22" fill="url(#redGradient)"/>${text(110, 2100, "GeekDance 极客跳动", 23, 750, "#FFFFFF")}${text(1150, 2100, "连接用户 · 赋能企业 · 创造价值", 19, 450, "#FFFFFF", "end")}<image href="${mascot}" x="1080" y="1944" width="156" height="156" preserveAspectRatio="xMidYMid meet"/>${brandBadge(logo, 1240, 2040, 308)}</svg>`;
  const finalSvg = applyGeneratedImageTypography(svg);
  return {
    svg: Buffer.from(finalSvg),
    png: await renderGeneratedImageSvg(finalSvg),
  };
}

function cleanDiagramPhrase(value: string) {
  return value
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/[*_`#>|]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[。；;！!？?，,：:]+$/gu, "")
    .trim();
}

function conciseDiagramPhrase(value: string) {
  const cleaned = cleanDiagramPhrase(value);
  const sentence =
    cleaned
      .split(/[。；;！!？?]/u)
      .map((part) => part.trim())
      .find(Boolean) ?? cleaned;
  if (Array.from(sentence).length <= 40) return sentence;
  return (
    sentence
      .split(/[，,：:]/u)
      .map((part) => part.trim())
      .find((part) => part.length >= 6 && part.length <= 40) ?? sentence
  );
}

const ARTICLE_HEADING_KEYWORDS = [
  "宠物市场",
  "市场机会",
  "用户需求",
  "产品定位",
  "商业模式",
  "业务流程",
  "客户体验",
  "订单协同",
  "需求验证",
  "开发交付",
  "数据趋势",
  "数据",
  "风险",
  "MVP",
  "AI Agent",
  "Agent",
  "APP",
  "App",
  "小程序",
] as const;

function articleHeadingKeyword(value: string) {
  const dictionaryMatch = ARTICLE_HEADING_KEYWORDS.find((keyword) =>
    value.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),
  );
  if (dictionaryMatch) return dictionaryMatch;
  const candidates = value
    .split(/[的与和及，,:：——–\s]+/u)
    .map((part) => part.replace(/[^一-鿿A-Za-z0-9-]/gu, "").trim())
    .filter(
      (part) =>
        Array.from(part).length >= 2 &&
        Array.from(part).length <= 6 &&
        !/^(?:如何|为什么|什么|这些|这个|一个|开始|进行)$/u.test(part),
    );
  return candidates.sort(
    (left, right) =>
      Array.from(right).length - Array.from(left).length ||
      value.indexOf(left) - value.indexOf(right),
  )[0];
}

function highlightedArticleHeading(
  x: number,
  top: number,
  width: number,
  height: number,
  value: string,
) {
  let fontSize = 42;
  let lines = [value];
  let fitted = false;
  for (; fontSize >= 16; fontSize -= 1) {
    lines = wrapByVisualUnits(value, width / (fontSize * 1.02));
    const lineHeight = fontSize * 1.16;
    if (lines.length * lineHeight <= height) {
      fitted = true;
      break;
    }
  }
  if (!fitted) {
    const maximumLines = 6;
    fontSize = Math.max(
      1,
      Math.min(
        16,
        height / (maximumLines * 1.16),
        (width * maximumLines) /
          (Math.max(1, measureVisualUnits(value)) * 1.08),
      ),
    );
    lines = wrapByVisualUnits(value, width / (fontSize * 1.02));
  }
  const lineHeight = fontSize * 1.16;
  const totalHeight = lines.length * lineHeight;
  const firstBaseline = top + (height - totalHeight) / 2 + fontSize;
  const keyword = articleHeadingKeyword(value) ?? "";
  const normalizedValue = value.toLocaleLowerCase();
  const keywordStart = keyword
    ? normalizedValue.indexOf(keyword.toLocaleLowerCase())
    : -1;
  const keywordEnd = keywordStart + keyword.length;
  let searchCursor = 0;
  return lines
    .map((line, index) => {
      const lineStart = Math.max(
        searchCursor,
        value.indexOf(line, searchCursor),
      );
      const lineEnd = lineStart + line.length;
      searchCursor = lineEnd;
      const highlightStart = Math.max(lineStart, keywordStart);
      const highlightEnd = Math.min(lineEnd, keywordEnd);
      const localStart = Math.max(0, highlightStart - lineStart);
      const localEnd = Math.max(localStart, highlightEnd - lineStart);
      const content =
        keywordStart >= 0 && highlightEnd > highlightStart
          ? `<tspan>${escapeXml(line.slice(0, localStart))}</tspan><tspan fill="${RED}">${escapeXml(line.slice(localStart, localEnd))}</tspan><tspan>${escapeXml(line.slice(localEnd))}</tspan>`
          : `<tspan>${escapeXml(line)}</tspan>`;
      return `<text data-exact-title="${escapeXml(value)}" x="${x}" y="${firstBaseline + index * lineHeight}" data-highlight-keyword="${escapeXml(keyword)}" font-size="${fontSize}" font-weight="700" fill="${INK}" font-family="${GENERATED_IMAGE_FONT_FAMILY}">${content}</text>`;
    })
    .join("");
}

function articleSectionTakeaway(
  section: CoreArticle["sections"][number],
  article: CoreArticle,
) {
  const source =
    section.paragraphs.find((paragraph) => paragraph.trim().length >= 8) ??
    section.heading ??
    article.conclusion;
  const sentence = conciseDiagramPhrase(source);
  return (
    sentence
      .split(/[，,：:]/u)
      .map((part) => part.trim())
      .find((part) => part.length >= 8) ?? sentence
  );
}

export function articleSectionDiagramLabels(
  section: CoreArticle["sections"][number],
) {
  const candidates =
    section.bullets.length >= 3
      ? section.bullets
      : [
          ...section.bullets,
          ...section.paragraphs.flatMap((paragraph) =>
            paragraph.split(/[。；;！!？?]/u),
          ),
        ];
  const labels: string[] = [];
  for (const candidate of candidates) {
    const label = conciseDiagramPhrase(candidate);
    if (label.length < 2 || labels.includes(label)) continue;
    labels.push(label);
    if (labels.length === 4) break;
  }
  return labels.length
    ? labels
    : [conciseDiagramPhrase(section.heading) || "章节要点"];
}

export type ArticleSectionVisualIntent =
  | "process"
  | "timeline"
  | "roadmap"
  | "funnel"
  | "comparison"
  | "trend"
  | "hierarchy"
  | "architecture"
  | "cycle"
  | "matrix"
  | "ecosystem"
  | "checklist"
  | "relationship"
  | "concept";

export function classifyArticleSectionVisual(
  section: CoreArticle["sections"][number],
): ArticleSectionVisualIntent {
  const body = `${section.heading} ${section.paragraphs.join(" ")} ${section.bullets.join(" ")}`;
  if (/转化|漏斗|获客|触达|成交|留存|流失|转化率/u.test(body)) return "funnel";
  if (/过去|现在|未来|演进|沿革|里程碑|时间轴|历程/u.test(body))
    return "timeline";
  if (/路线图|短期|中期|长期|规划|落地路径|实施路径/u.test(body))
    return "roadmap";
  if (
    /技术架构|系统架构|数据层|服务层|应用层|前端|后端|模块|子系统/u.test(body)
  )
    return "architecture";
  if (/生态|参与方|角色|供给|需求方|平台方|合作伙伴/u.test(body))
    return "ecosystem";
  if (/清单|原则|建议|注意事项|关键动作|检查项/u.test(body)) return "checklist";
  if (
    /增长|下降|趋势|变化|提升|降低|同比|环比|\d+(?:\.\d+)?\s*[%％]/u.test(body)
  )
    return "trend";
  if (/对比|相比|区别|差异|取舍|而不是|优缺点|高于|低于/u.test(body))
    return "comparison";
  if (/闭环|循环|持续迭代|反馈/u.test(body)) return "cycle";
  if (/维度|优先级|象限|高低|紧急|重要/u.test(body)) return "matrix";
  if (/先|再|随后|然后|最后|步骤|阶段|流程|流转|从.+到/u.test(body))
    return "process";
  if (/层级|底层|上层|支撑|组成|结构|体系|分为/u.test(body)) return "hierarchy";
  if (/依赖|影响|关联|协同|连接|关系|导致|因此|驱动/u.test(body))
    return "relationship";
  return "concept";
}

/**
 * Renders normal-article chapter illustrations as deterministic information
 * diagrams. Keeping the labels outside the image model prevents portraits,
 * fake interfaces and corrupted Chinese copy from entering editorial images.
 */
export async function renderArticleSectionDiagram(
  article: CoreArticle,
  section: CoreArticle["sections"][number],
  sectionIndex: number,
  ratio: "4:3",
  logo?: Uint8Array | Buffer,
  requestedIntent?: ArticleSectionVisualIntent,
  visualTexture?: Uint8Array | Buffer,
) {
  void ratio;
  const width = 1200;
  const height = 900;
  const safe = 68;
  const labels = articleSectionDiagramLabels(section);
  const heading = cleanDiagramPhrase(section.heading) || "章节要点";
  const layout = requestedIntent ?? classifyArticleSectionVisual(section);
  const contentY = 250;
  const contentWidth = width - safe * 2;
  const logoWidth = 190;
  const logoHeight = 76;
  const brandImage = logo
    ? `<image data-gd-company-logo="true" data-gd-logo-position="top-right" href="${dataUri(Buffer.from(logo))}" x="${width - safe - logoWidth}" y="42" width="${logoWidth}" height="${logoHeight}" preserveAspectRatio="xMidYMid meet"/>`
    : text(width - safe, 84, "极客跳动", 24, 820, RED, "end");
  // Destroy all glyph-level detail before the model output reaches the final
  // editorial image. This keeps image-2's broad visual tone while ensuring
  // every readable character is rendered from verified article text below.
  const textureSeed = visualTexture
    ? await sharp(Buffer.from(visualTexture))
        .resize(16, 12, { fit: "cover" })
        .removeAlpha()
        .png()
        .toBuffer()
    : undefined;
  const texture = textureSeed
    ? await sharp(textureSeed)
        .resize(width, height, { fit: "fill" })
        .blur(36)
        .modulate({ saturation: 0.25, brightness: 1.08 })
        .png({ compressionLevel: 9 })
        .toBuffer()
    : undefined;
  const textureImage = texture
    ? `<image data-image-2-visual-texture="true" href="${dataUri(texture)}" x="0" y="210" width="${width}" height="590" opacity=".065" preserveAspectRatio="xMidYMid slice"/>`
    : "";
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-diagram-type="article-section" data-diagram-layout="${layout}" data-section-index="${sectionIndex}"><defs><filter id="sectionShadow" x="-20%" y="-30%" width="140%" height="170%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#17171A" flood-opacity=".06"/></filter><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z" fill="${RED}"/></marker></defs><rect width="${width}" height="${height}" fill="#FFFFFF"/>${textureImage}<rect x="0" y="0" width="1200" height="220" fill="#FFFFFF"/>${brandImage}<rect x="${safe}" y="65" width="42" height="6" rx="3" fill="${RED}"/>${highlightedArticleHeading(safe, 82, 810, 112, heading)}<path d="M${safe} 208H${width - safe}" stroke="#ECEDEF" stroke-width="2"/>`;
  if (layout === "process") {
    const gap = 44;
    const cardWidth =
      (contentWidth - gap * (labels.length - 1)) / labels.length;
    const cardHeight = 260;
    for (const [index, label] of labels.entries()) {
      const x = safe + index * (cardWidth + gap);
      const y = contentY + (index % 2) * 80;
      if (index)
        svg += `<path d="M${x - gap + 8} ${y - 28 + cardHeight / 2}C${x - 28} ${y - 28 + cardHeight / 2},${x - 28} ${y + cardHeight / 2},${x - 8} ${y + cardHeight / 2}" fill="none" stroke="${RED}" stroke-width="4" marker-end="url(#arrow)"/>`;
      svg += `<rect x="${x}" y="${y}" width="${cardWidth}" height="300" rx="28" fill="#FFFFFF" stroke="#E4E5E8" stroke-width="2" filter="url(#sectionShadow)"/><circle cx="${x + cardWidth / 2}" cy="${y + 82}" r="52" fill="${index === labels.length - 1 ? RED : "#F4F4F5"}"/>${text(x + cardWidth / 2, y + 94, String(index + 1).padStart(2, "0"), 30, 820, index === labels.length - 1 ? "#FFFFFF" : RED, "middle")}${fittedTextBox(x + 16, y + 148, cardWidth - 32, 124, label, { maxSize: 28, minSize: 14, maxLines: 4 })}`;
    }
  } else if (layout === "hierarchy") {
    const layerHeight = 112;
    const gap = 30;
    for (const [index, label] of labels.entries()) {
      const inset = index * 110;
      const x = safe + inset;
      const y = contentY + index * (layerHeight + gap);
      const layerWidth = contentWidth - inset * 2;
      svg += `<path d="M${x} ${y + layerHeight}H${x + layerWidth}" stroke="${index === labels.length - 1 ? RED : "#BFC1C7"}" stroke-width="10" stroke-linecap="round"/>${text(x + 22, y + 48, `0${index + 1}`, 24, 820, RED)}${fittedTextBox(x + 110, y + 8, layerWidth - 132, 82, label, { maxSize: 32, minSize: 15, maxLines: 3, align: "start" })}`;
    }
  } else if (layout === "timeline") {
    const shown = labels.slice(0, 4);
    const lineX = 286;
    svg += `<path d="M${lineX} 280V724" stroke="#D7D8DC" stroke-width="8" stroke-linecap="round"/>`;
    shown.forEach((label, index) => {
      const y = 300 + index * (420 / Math.max(1, shown.length - 1));
      svg += `<circle cx="${lineX}" cy="${y}" r="${index === shown.length - 1 ? 30 : 22}" fill="${index === shown.length - 1 ? RED : "#FFFFFF"}" stroke="${RED}" stroke-width="7"/><rect x="360" y="${y - 58}" width="720" height="116" rx="24" fill="${index % 2 ? "#F6F6F7" : "#FFFFFF"}" stroke="#E2E3E6" stroke-width="2"/>${text(402, y - 14, String(index + 1).padStart(2, "0"), 21, 700, RED)}${fittedTextBox(472, y - 42, 564, 84, label, { maxSize: 29, minSize: 15, maxLines: 3, align: "start" })}`;
    });
  } else if (layout === "roadmap") {
    const shown = labels.slice(0, 4);
    const points = [
      [178, 625],
      [420, 370],
      [735, 600],
      [1020, 330],
    ].slice(0, shown.length);
    svg += `<path d="M178 625C300 610 318 365 420 370S620 628 735 600 895 360 1020 330" fill="none" stroke="#D7D8DC" stroke-width="26" stroke-linecap="round"/><path d="M178 625C300 610 318 365 420 370S620 628 735 600 895 360 1020 330" fill="none" stroke="${RED}" stroke-width="6" stroke-linecap="round" stroke-dasharray="12 18"/>`;
    points.forEach(([x, y], index) => {
      const label = shown[index]!;
      const above = index % 2 === 0;
      svg += `<circle cx="${x}" cy="${y}" r="42" fill="${index === points.length - 1 ? RED : "#FFFFFF"}" stroke="${RED}" stroke-width="5"/>${text(x!, y! + 10, String(index + 1), 27, 700, index === points.length - 1 ? "#FFFFFF" : RED, "middle")}${fittedTextBox(x! - 112, above ? y! - 154 : y! + 62, 224, 92, label, { maxSize: 24, minSize: 13, maxLines: 3 })}`;
    });
  } else if (layout === "funnel") {
    const shown = labels.slice(0, 4);
    shown.forEach((label, index) => {
      const topWidth = 820 - index * 150;
      const bottomWidth = topWidth - 110;
      const y = 270 + index * 118;
      const topLeft = 600 - topWidth / 2;
      const bottomLeft = 600 - bottomWidth / 2;
      svg += `<polygon points="${topLeft},${y} ${topLeft + topWidth},${y} ${bottomLeft + bottomWidth},${y + 94} ${bottomLeft},${y + 94}" fill="${index === shown.length - 1 ? RED : index % 2 ? "#EFEFF1" : "#F7F7F8"}" stroke="${index === shown.length - 1 ? RED : "#D9DADE"}" stroke-width="2"/>${text(600, y + 34, String(index + 1).padStart(2, "0"), 18, 700, index === shown.length - 1 ? "#FFFFFF" : RED, "middle")}${fittedTextBox(600 - bottomWidth / 2 + 26, y + 38, bottomWidth - 52, 48, label, { maxSize: 23, minSize: 12, maxLines: 2, fill: index === shown.length - 1 ? "#FFFFFF" : INK })}`;
    });
  } else if (layout === "architecture") {
    const shown = labels.slice(0, 4);
    const layerColors = ["#17171A", "#F0F0F2", "#FFF1F2", "#FFFFFF"];
    shown.forEach((label, index) => {
      const y = 270 + index * 118;
      const inset = index % 2 ? 90 : 0;
      const x = safe + inset;
      const layerWidth = contentWidth - inset * 2;
      svg += `<rect x="${x}" y="${y}" width="${layerWidth}" height="92" rx="22" fill="${layerColors[index]}" stroke="${index === 2 ? BORDER : "#D9DADE"}" stroke-width="2"/>${text(x + 42, y + 56, `L${index + 1}`, 22, 700, index === 0 ? "#FFFFFF" : RED)}${fittedTextBox(x + 126, y + 14, layerWidth - 168, 64, label, { maxSize: 27, minSize: 14, maxLines: 2, align: "start", fill: index === 0 ? "#FFFFFF" : INK })}`;
      if (index < shown.length - 1)
        svg += `<path d="M600 ${y + 92}V${y + 118}" stroke="${RED}" stroke-width="4" marker-end="url(#arrow)"/>`;
    });
  } else if (layout === "ecosystem") {
    const center = labels[0] ?? heading;
    svg += `<circle cx="600" cy="500" r="238" fill="none" stroke="#E4E5E8" stroke-width="2" stroke-dasharray="10 14"/><circle cx="600" cy="500" r="142" fill="${RED}"/>${fittedTextBox(490, 405, 220, 190, center, { maxSize: 31, minSize: 14, maxLines: 5, weight: 700, fill: "#FFFFFF" })}`;
    const orbit = [
      [600, 270],
      [904, 468],
      [752, 704],
      [296, 565],
    ];
    labels.slice(1, 5).forEach((label, index) => {
      const [x, y] = orbit[index]!;
      svg += `<circle cx="${x}" cy="${y}" r="82" fill="#FFFFFF" stroke="${index % 2 ? BORDER : "#D9DADE"}" stroke-width="3"/>${fittedTextBox(x! - 66, y! - 48, 132, 96, label, { maxSize: 23, minSize: 12, maxLines: 4 })}`;
    });
  } else if (layout === "checklist") {
    const shown = labels.slice(0, 4);
    shown.forEach((label, index) => {
      const y = 270 + index * 112;
      svg += `<text x="${safe}" y="${y + 62}" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="74" font-weight="700" fill="${index === 0 ? RED : "#E1E2E5"}">${String(index + 1).padStart(2, "0")}</text><circle cx="238" cy="${y + 42}" r="24" fill="${index === 0 ? RED : SOFT_RED}"/><path d="m226 ${y + 42} 9 9 18-23" fill="none" stroke="${index === 0 ? "#FFFFFF" : RED}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>${fittedTextBox(290, y, 790, 84, label, { maxSize: 30, minSize: 15, maxLines: 3, align: "start" })}<path d="M290 ${y + 94}H1080" stroke="#E8E8EB" stroke-width="2"/>`;
    });
  } else if (layout === "comparison") {
    const sideWidth = 430;
    svg += `<path d="M600 260V700" stroke="#D8D9DD" stroke-width="2"/><circle cx="600" cy="475" r="48" fill="${RED}"/>${text(600, 485, "VS", 25, 850, "#FFFFFF", "middle")}`;
    [labels[0] ?? heading, labels[1] ?? labels[0] ?? heading].forEach(
      (label, index) => {
        const x = index ? 702 : safe;
        svg += `<rect x="${x}" y="${contentY + 8}" width="${sideWidth}" height="420" rx="32" fill="#FFFFFF" stroke="${index ? "#D8D9DD" : BORDER}" stroke-width="2" filter="url(#sectionShadow)"/><circle cx="${x + 72}" cy="${contentY + 82}" r="48" fill="${index ? "#F1F2F4" : SOFT_RED}"/>${text(x + 72, contentY + 92, index ? "B" : "A", 29, 850, index ? MUTED : RED, "middle")}${fittedTextBox(x + 34, contentY + 158, sideWidth - 68, 190, label, { maxSize: 36, minSize: 16, maxLines: 4 })}<path d="M${x + 34} ${contentY + 382}H${x + sideWidth - 34}" stroke="${index ? "#AEB0B6" : RED}" stroke-width="6" stroke-linecap="round"/>`;
      },
    );
    if (labels[2])
      svg += fittedTextBox(320, 710, 560, 72, labels[2], {
        maxSize: 25,
        minSize: 14,
        maxLines: 2,
        fill: MUTED,
      });
  } else if (layout === "trend") {
    const directionDown = /下降|降低|减少|缩短/u.test(
      `${section.heading} ${section.paragraphs.join(" ")}`,
    );
    const stageCount = Math.max(2, Math.min(4, labels.length));
    const startY = directionDown ? contentY + 90 : contentY + 390;
    const endY = directionDown ? contentY + 390 : contentY + 90;
    const points = Array.from({ length: stageCount }, (_, index) => {
      const progress = index / Math.max(1, stageCount - 1);
      return {
        x: safe + 120 + progress * (contentWidth - 240),
        y: startY + progress * (endY - startY),
        label: labels[index] ?? labels.at(-1) ?? heading,
      };
    });
    svg += `<path d="M${safe + 70} ${contentY + 470}H${width - safe}" stroke="#D8D9DD" stroke-width="2"/><polyline points="${points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${RED}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)"/>`;
    points.forEach((point, index) => {
      svg += `<circle cx="${point.x}" cy="${point.y}" r="14" fill="#FFFFFF" stroke="${RED}" stroke-width="7"/>${fittedTextBox(point.x - 96, contentY + 500, 192, 96, point.label, { maxSize: 23, minSize: 13, maxLines: 3, weight: 650, fill: index === points.length - 1 ? RED : MUTED })}`;
    });
  } else if (layout === "cycle") {
    const positions = [
      [600, 300],
      [890, 500],
      [600, 700],
      [310, 500],
    ];
    positions
      .slice(0, Math.max(3, labels.length))
      .forEach(([x, y], index, nodes) => {
        const next = nodes[(index + 1) % nodes.length]!;
        svg += `<path d="M${x} ${y}Q${(x! + next[0]!) / 2 + (index % 2 ? 40 : -40)} ${(y! + next[1]!) / 2}${next[0]} ${next[1]}" fill="none" stroke="#C9CBD0" stroke-width="5" marker-end="url(#arrow)"/><circle cx="${x}" cy="${y}" r="86" fill="${index === 0 ? SOFT_RED : "#F5F5F6"}" stroke="${index === 0 ? RED : "#D8D9DD"}" stroke-width="3"/>${fittedTextBox(x! - 68, y! - 48, 136, 96, labels[index % labels.length]!, { maxSize: 25, minSize: 13, maxLines: 4 })}`;
      });
  } else if (layout === "matrix") {
    svg += `<path d="M600 260V720M180 490H1020" stroke="#BFC1C7" stroke-width="3"/><path d="M600 260l-10 18h20ZM1020 490l-18-10v20Z" fill="${RED}"/>`;
    const positions = [
      [360, 360],
      [790, 360],
      [360, 610],
      [790, 610],
    ];
    labels.forEach((label, index) => {
      const [x, y] = positions[index]!;
      svg += `<circle cx="${x}" cy="${y}" r="78" fill="${index === 0 ? RED : "#F1F2F4"}"/>${fittedTextBox(x! - 62, y! - 48, 124, 96, label, { maxSize: 23, minSize: 12, maxLines: 4, fill: index === 0 ? "#FFFFFF" : INK })}`;
    });
  } else if (layout === "relationship") {
    const center = labels[0] ?? heading;
    svg += `<circle cx="600" cy="480" r="124" fill="${RED}"/>${fittedTextBox(500, 390, 200, 180, center, { maxSize: 29, minSize: 13, maxLines: 5, weight: 800, fill: "#FFFFFF" })}`;
    const positions = [
      [250, 330],
      [950, 330],
      [250, 650],
      [950, 650],
    ];
    labels
      .slice(1)
      .concat(section.bullets.slice(labels.length, 4))
      .slice(0, 4)
      .forEach((label, index) => {
        const [x, y] = positions[index]!;
        svg += `<path d="M${600 + (x! < 600 ? -110 : 110)} ${480 + (y! < 480 ? -50 : 50)}L${x} ${y}" stroke="#C6C8CD" stroke-width="5" marker-end="url(#arrow)"/><circle cx="${x}" cy="${y}" r="84" fill="#F4F4F5" stroke="#D8D9DD" stroke-width="2"/>${fittedTextBox(x! - 68, y! - 48, 136, 96, label, { maxSize: 24, minSize: 12, maxLines: 4 })}`;
      });
  } else {
    const center = labels[0] ?? heading;
    svg += `<circle cx="600" cy="490" r="176" fill="#F6F6F7" stroke="${RED}" stroke-width="5"/>${fittedTextBox(460, 365, 280, 250, center, { maxSize: 36, minSize: 15, maxLines: 5, weight: 820 })}`;
    labels.slice(1).forEach((label, index) => {
      const x = index ? 930 : 270;
      const y = index ? 610 : 350;
      svg += `<path d="M${index ? 755 : 445} ${index ? 550 : 410}L${x} ${y}" stroke="${RED}" stroke-width="5" marker-end="url(#arrow)"/><circle cx="${x}" cy="${y}" r="102" fill="#FFFFFF" stroke="#D8D9DD" stroke-width="3"/>${fittedTextBox(x - 82, y - 60, 164, 120, label, { maxSize: 25, minSize: 12, maxLines: 5 })}`;
    });
  }
  const takeaway = articleSectionTakeaway(section, article);
  svg += `<rect x="${safe}" y="804" width="${contentWidth}" height="74" rx="37" fill="#FFFFFF" stroke="#E5E5E8" stroke-width="2" filter="url(#sectionShadow)"/><circle cx="104" cy="841" r="17" fill="${SOFT_RED}"/><circle cx="104" cy="841" r="6" fill="${RED}"/>${fittedTextBox(144, 814, 934, 54, takeaway, { maxSize: 22, minSize: 14, maxLines: 2, weight: 620 })}</svg>`;
  const finalSvg = applyGeneratedImageTypography(svg);
  return {
    svg: Buffer.from(finalSvg),
    png: await renderGeneratedImageSvg(finalSvg),
  };
}

async function integratedCoverLogo(logo: Uint8Array | Buffer) {
  const logoRaw = await sharp(logo)
    .resize({ width: 286 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const logoPixels = Buffer.from(logoRaw.data);
  for (let index = 0; index < logoPixels.length; index += 4) {
    if (
      logoPixels[index + 3]! > 0 &&
      logoPixels[index]! < 96 &&
      logoPixels[index + 1]! < 96 &&
      logoPixels[index + 2]! < 96
    ) {
      logoPixels[index] = 255;
      logoPixels[index + 1] = 255;
      logoPixels[index + 2] = 255;
    }
  }
  const coverLogo = await sharp(logoPixels, {
    raw: {
      width: logoRaw.info.width,
      height: logoRaw.info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
  return coverLogo;
}

export async function overlayCaseCoverTitle(
  image: Uint8Array,
  title: string,
  logoPath: string,
) {
  const logo = await readFile(logoPath);
  const coverLogo = await integratedCoverLogo(logo);
  const hero = await sharp(Buffer.from(image))
    .resize(1620, 2160, { fit: "cover" })
    .modulate({ brightness: 0.94, saturation: 0.94 })
    .toBuffer();
  const overlay = Buffer.from(
    `<svg width="1620" height="2160" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse"><path d="M72 0H0V72" fill="none" stroke="#FFFFFF" stroke-opacity=".04"/></pattern><linearGradient id="titleShade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#08090B" stop-opacity=".97"/><stop offset=".28" stop-color="#08090B" stop-opacity=".88"/><stop offset=".43" stop-color="#08090B" stop-opacity=".42"/><stop offset=".58" stop-color="#08090B" stop-opacity=".05"/><stop offset="1" stop-color="#08090B" stop-opacity=".08"/></linearGradient><linearGradient id="redGlow" x1="0" x2="1"><stop stop-color="${RED}" stop-opacity=".9"/><stop offset="1" stop-color="${DEEP_RED}" stop-opacity="0"/></linearGradient></defs><rect width="1620" height="2160" fill="url(#titleShade)"/><rect width="1620" height="2160" fill="url(#grid)"/><rect x="72" y="104" width="244" height="64" rx="32" fill="${RED}"/>${text(194, 146, "项目案例", 26, 760, "#FFFFFF", "middle")}${coverTitleText(72, 300, title.slice(0, 45))}<rect x="72" y="590" width="360" height="14" rx="7" fill="url(#redGlow)"/><path d="M1262 163h286" stroke="${RED}" stroke-width="4" stroke-linecap="round" opacity=".8"/><rect x="72" y="2052" width="1476" height="2" fill="#FFFFFF" opacity=".18"/>${text(72, 2104, "GeekDance · SOFTWARE & AI SOLUTIONS", 22, 650, "#FFFFFF")}</svg>`,
  );
  const base = Buffer.from(
    `<svg width="1620" height="2160" xmlns="http://www.w3.org/2000/svg"><rect width="1620" height="2160" fill="#08090B"/></svg>`,
  );
  return sharp(base)
    .composite([
      { input: hero, left: 0, top: 0 },
      { input: overlay },
      { input: coverLogo, left: 1262, top: 70 },
    ])
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export async function replaceCoverTextInRegion(
  image: Uint8Array,
  replacement: string,
  region: { x: number; y: number; width: number; height: number },
) {
  const source = sharp(Buffer.from(image)).rotate();
  const metadata = await source.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("COVER_TEXT_IMAGE_INVALID");
  const left = Math.max(0, Math.min(width - 1, Math.round(region.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(region.y * height)));
  const boxWidth = Math.max(
    1,
    Math.min(width - left, Math.round(region.width * width)),
  );
  const boxHeight = Math.max(
    1,
    Math.min(height - top, Math.round(region.height * height)),
  );
  const patch = await sharp(Buffer.from(image))
    .rotate()
    .extract({ left, top, width: boxWidth, height: boxHeight })
    .blur(
      Math.max(8, Math.min(36, Math.round(Math.min(boxWidth, boxHeight) / 8))),
    )
    .toBuffer();
  const stats = await sharp(patch).stats();
  const red = Math.round(stats.channels[0]?.mean ?? 32);
  const green = Math.round(stats.channels[1]?.mean ?? 32);
  const blue = Math.round(stats.channels[2]?.mean ?? 32);
  const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
  const textColor = luminance > 145 ? "#17171A" : "#FFFFFF";
  const cleaned = replacement.replace(/\s+/gu, " ").trim().slice(0, 80);
  if (!cleaned) throw new Error("COVER_TEXT_REPLACEMENT_REQUIRED");
  let fontSize = Math.max(12, Math.min(boxHeight * 0.64, boxWidth * 0.2));
  let lines = [cleaned];
  for (; fontSize >= 12; fontSize -= 1) {
    lines = wrapByVisualUnits(
      cleaned,
      Math.max(2, boxWidth / (fontSize * 1.02)),
    );
    if (lines.length * fontSize * 1.22 <= boxHeight * 0.82) break;
  }
  const lineHeight = fontSize * 1.22;
  const firstBaseline =
    (boxHeight - lines.length * lineHeight) / 2 + fontSize * 0.92;
  const textSvg = Buffer.from(
    `<svg width="${boxWidth}" height="${boxHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="rgb(${red},${green},${blue})" fill-opacity=".28"/>${lines
      .map(
        (line, index) =>
          `<text data-exact-replacement="${escapeXml(cleaned)}" x="${boxWidth / 2}" y="${firstBaseline + index * lineHeight}" text-anchor="middle" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="${fontSize}" font-weight="700" fill="${textColor}">${escapeXml(line)}</text>`,
      )
      .join("")}</svg>`,
  );
  return source
    .composite([
      { input: patch, left, top },
      { input: textSvg, left, top },
    ])
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export async function renderFallbackCaseCover(
  title: string,
  description: string,
  options: { logoPath: string; mascotPath: string },
) {
  const [logoBytes, mascotBytes] = await Promise.all([
    readFile(options.logoPath),
    readFile(options.mascotPath),
  ]);
  const mascot = dataUri(mascotBytes);
  const coverLogo = await integratedCoverLogo(logoBytes);
  const summary = description.trim().slice(0, 96);
  const heroDetails = fallbackCaseHeroDetails(title, description);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1620" height="2160" viewBox="0 0 1620 2160"><defs><pattern id="coverGrid" width="72" height="72" patternUnits="userSpaceOnUse"><path d="M72 0H0V72" fill="none" stroke="#FFFFFF" stroke-opacity=".055"/></pattern><linearGradient id="coverRed" x1="0" x2="1"><stop stop-color="${RED}"/><stop offset="1" stop-color="${DEEP_RED}"/></linearGradient><radialGradient id="coverGlow" cx="76%" cy="72%" r="58%"><stop stop-color="${RED}" stop-opacity=".58"/><stop offset=".45" stop-color="${DEEP_RED}" stop-opacity=".14"/><stop offset="1" stop-color="#08090B" stop-opacity="0"/></radialGradient><filter id="coverShadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="24" stdDeviation="30" flood-color="#000000" flood-opacity=".7"/></filter></defs><rect width="1620" height="2160" fill="#08090B"/><rect width="1620" height="2160" fill="url(#coverGrid)"/><rect width="1620" height="2160" fill="url(#coverGlow)"/><rect x="72" y="104" width="244" height="64" rx="32" fill="url(#coverRed)"/>${text(194, 146, "方案型案例", 26, 760, "#FFFFFF", "middle")}<path d="M1262 163h286" stroke="${RED}" stroke-width="4" stroke-linecap="round" opacity=".8"/>${coverTitleText(72, 300, title.slice(0, 45))}<rect x="72" y="600" width="360" height="14" rx="7" fill="url(#coverRed)"/>${multiline(72, 690, summary, 31, 28, 42, 430, "#D8D8DC", "start", 3)}<g filter="url(#coverShadow)" transform="translate(300 950) rotate(-7 500 520)"><rect width="1020" height="900" rx="58" fill="#F8F8F8" stroke="#FFFFFF" stroke-width="8"/><rect x="58" y="62" width="904" height="108" rx="28" fill="#15161A"/><circle cx="116" cy="116" r="15" fill="${RED}"/><rect x="162" y="100" width="310" height="28" rx="14" fill="#FFFFFF" opacity=".9"/><rect x="58" y="228" width="330" height="594" rx="34" fill="url(#coverRed)"/><circle cx="223" cy="394" r="96" fill="#FFFFFF" opacity=".16"/><path d="M142 560h170M142 620h130M142 680h156" stroke="#FFFFFF" stroke-width="22" stroke-linecap="round" opacity=".94"/><rect x="438" y="228" width="524" height="190" rx="34" fill="#FFFFFF" stroke="#D7D7DB" stroke-width="3"/><rect x="482" y="278" width="260" height="30" rx="15" fill="${RED}"/><rect x="482" y="338" width="386" height="18" rx="9" fill="#BFC0C5"/><rect x="438" y="470" width="242" height="352" rx="34" fill="#FFFFFF" stroke="#D7D7DB" stroke-width="3"/><rect x="720" y="470" width="242" height="352" rx="34" fill="#FFFFFF" stroke="#D7D7DB" stroke-width="3"/><circle cx="559" cy="588" r="60" fill="#FFF0F1"/><circle cx="841" cy="588" r="60" fill="#FFF0F1"/><path d="M519 588h80M801 588h80" stroke="${RED}" stroke-width="16" stroke-linecap="round"/><path d="M500 710h118M782 710h118" stroke="#BFC0C5" stroke-width="18" stroke-linecap="round"/></g>${heroDetails}<rect x="72" y="2052" width="1476" height="2" fill="#FFFFFF" opacity=".18"/>${text(72, 2104, "GeekDance · SOFTWARE & AI SOLUTIONS", 22, 650, "#FFFFFF")}<image href="${mascot}" x="1370" y="1940" width="130" height="130" preserveAspectRatio="xMidYMid meet"/></svg>`,
  );
  return sharp(await renderGeneratedImageSvg(svg))
    .composite([{ input: coverLogo, left: 1262, top: 70 }])
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
