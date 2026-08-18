import type { CoreArticle } from "@geekdance/shared";
import { AI_WRITING_PATTERNS } from "./rules.js";

export function brandHumanize(article: CoreArticle): CoreArticle {
  const clean = (value: string) => {
    let text = value
      .replace(/—{1,2}/g, "，")
      .replace(/\s+/g, " ")
      .trim();
    for (const phrase of AI_WRITING_PATTERNS)
      text = text.replaceAll(phrase, phrase === "此外" ? "" : "");
    return text.replace(/，，+/g, "，").replace(/^，|，$/g, "");
  };
  return {
    ...article,
    title: clean(article.title),
    description: clean(article.description),
    opening: article.opening.map(clean),
    sections: article.sections.map((section) => ({
      ...section,
      heading: clean(section.heading),
      paragraphs: section.paragraphs.map(clean),
      bullets: section.bullets.map(clean),
    })),
    observation: clean(article.observation),
    conclusion: clean(article.conclusion),
    summaryPoints: article.summaryPoints?.map(clean) as
      [string, string, string] | undefined,
    cta: clean(article.cta),
  };
}
