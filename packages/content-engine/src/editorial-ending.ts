import type { CoreArticle } from "@geekdance/shared";

const CONDITIONAL_OPENING =
  /^(?:如果|若(?:是)?|假如|倘若|当|只要|除非|即使|无论)/u;
const CONSEQUENCE_CLAUSE =
  /[，,].*(?:就|则|便|也|仍|可以|可先|应当|应该|应先|需要|建议|不妨|值得|优先|必须|务必|不应|不能)/u;
const DANGLING_ENDING =
  /(?:以及|并且|或者|或|和|与|但|而|从而|为了|通过|围绕|基于|针对|面向|对于|包括|例如|如下)$/u;

export function isCompleteEditorialSentence(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || !/[。！？!?]$/u.test(normalized)) return false;
  const withoutPunctuation = normalized.replace(/[。！？!?]+$/u, "").trim();
  if (!withoutPunctuation || DANGLING_ENDING.test(withoutPunctuation))
    return false;
  if (
    CONDITIONAL_OPENING.test(withoutPunctuation) &&
    !CONSEQUENCE_CLAUSE.test(withoutPunctuation)
  )
    return false;
  return true;
}

export function toIndependentEditorialSentence(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!CONDITIONAL_OPENING.test(normalized)) return normalized;
  for (const match of normalized.matchAll(/[，,]/gu)) {
    const tail = normalized.slice((match.index ?? -1) + 1).trim();
    const actionIndex = tail.search(
      /(?:就|则|便|也|仍|可以|可先|应当|应该|应先|需要|建议|不妨|值得|优先|必须|务必|不应|不能)/u,
    );
    if (actionIndex >= 0 && actionIndex <= 12) return tail;
  }
  return normalized;
}

export function editorialEndingErrors(article: CoreArticle) {
  const errors: string[] = [];
  if (!isCompleteEditorialSentence(article.conclusion))
    errors.push("总结必须是语义完整、带结束标点的独立句子");
  if (!isCompleteEditorialSentence(article.cta))
    errors.push(
      "总结行动建议必须是语义完整的独立句子；不能只写“如果/若/当……”条件从句",
    );
  return errors;
}
