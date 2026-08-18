const CASE_PATTERNS = [
  /客户案例/,
  /案例类文章/,
  /产品案例/,
  /交付案例/,
  /实施案例/,
  /项目复盘/,
  /实施结果/,
  /客户故事/,
  /某(?:公司|企业|客户).*(?:上线|交付|落地|效果)/,
];

const NEGATION_PATTERN =
  /(?:不得|不要|禁止|避免|不可|不应|不能|不虚构|拒绝|无须|无需|不需要)/;

export function classifyContentScope(topic: string, title = "", remarks = "") {
  const text = `${topic} ${title} ${remarks}`;
  const isCase = CASE_PATTERNS.some((pattern) => {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) return false;
    const precedingContext = text.slice(
      Math.max(0, match.index - 24),
      match.index,
    );
    return !NEGATION_PATTERN.test(precedingContext);
  });
  return isCase
    ? { scope: "case" as const, route: "xiaohongshu_case_workflow" as const }
    : { scope: "general" as const };
}
