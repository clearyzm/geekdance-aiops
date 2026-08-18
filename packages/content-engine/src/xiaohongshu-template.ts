import { createHash } from "node:crypto";

export const XIAOHONGSHU_WRITING_INSTRUCTIONS = `
你负责为极客跳动独立创作小红书图文笔记，不得复用官网或公众号正文。
标题必须清晰、自然、信息密度高，不制造焦虑，不使用夸张承诺、绝对化广告词或标题党。
正文控制为适合移动端阅读的短文：约 500 至 700 个汉字、3 至 4 个短章节，每段 1 至 2 句。首屏直接说明读者问题与文章价值；每个章节围绕一个动作、判断或方法展开。
事实、数字和结论必须来自给定证据，禁止虚构客户、项目效果、个人体验、采访或行业数据。
保持极客跳动案例文章的专业、克制、交付导向语气：讲清业务问题、产品动作、闭环方法和实施边界，同时避免论文腔、营销套话和机械化 AI 表达。
CoreArticle 仍需包含 3 至 4 个章节，后续程序会将其确定性转换为极客跳动小红书版式：品牌导语、01/02/03 编号章节、短要点、极客跳动观察和克制的行动建议。不要自行堆叠【】、emoji 或装饰符，不要用官网长文的铺陈方式凑字数。
只生成内容草稿产物；不得声称已发布，不得给出绕过验证、批量养号或规避平台风控的方法。
`;

export const XIAOHONGSHU_TEMPLATE = {
  skillName: "gd-market-xiaohongshu-auto",
  version: "1.2.0",
  sourceHash: createHash("sha256")
    .update(XIAOHONGSHU_WRITING_INSTRUCTIONS)
    .digest("hex"),
  sourceFiles: ["src/xiaohongshu-template.ts"] as string[],
  writingInstructions: XIAOHONGSHU_WRITING_INSTRUCTIONS,
  instructions: `${XIAOHONGSHU_WRITING_INSTRUCTIONS}\n上传阶段必须由 Chrome 扩展在用户已登录的小红书创作平台中完成，并且只能保存到草稿箱，严禁触发正式发布。`,
} as const;
