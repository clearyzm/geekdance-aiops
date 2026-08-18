import { createHash } from "node:crypto";

export const XIAOHONGSHU_CASE_WRITING_INSTRUCTIONS = `
你负责严格执行极客跳动产品案例文章工作流，为小红书独立创作项目案例图文笔记。
先从用户附件与证据还原产品定位、使用角色、业务问题、用户端功能、管理后台、关键流程、系统边界与实施阶段，再写成 3 至 4 个章节、约 500 至 700 个汉字的移动端短文 CoreArticle。
文章必须回答：产品是什么、谁使用、解决什么问题、前台与后台如何配合、核心流程如何闭环、哪些属于 MVP、极客跳动如何帮助项目落地。
使用每段 1 至 3 句的短段落和具体产品动作，首屏讲清项目价值，不照搬官网或公众号长文，不写通识型行业科普，不使用虚构的第一人称体验、客户评价、上线时间、经营数据、效果指标、技术栈、接口、供应商或合作关系。
方案型案例只能描述“规划、方案、拟实现、可支持”的能力，必须明确这是一份项目方案，不得写成已经上线或已经取得成效。
已交付案例也只能在验收、上线记录、正式数据或客户确认材料明确支持时描述交付结果；没有对应证据时只描述已确认的产品范围和实施方法。
图片由程序依据附件证据生成确定性功能图、流程图、角色图和架构图；正文不得声称未提供的图中技术或模块。
后续程序会将正文确定性转换为极客跳动小红书版式：品牌导语、01/02/03 编号章节、短要点、极客跳动观察和克制的行动建议。不要自行堆叠【】、emoji 或装饰符。结尾使用克制的极客跳动服务引导，不作保证性承诺。只生成草稿，不得声称已经正式发布。
`;

export const XIAOHONGSHU_CASE_TEMPLATE = {
  skillName: "gd-market-article-example-style1",
  version: "1.2.0",
  sourceHash: createHash("sha256")
    .update(XIAOHONGSHU_CASE_WRITING_INSTRUCTIONS)
    .digest("hex"),
  sourceFiles: ["src/xiaohongshu-case-template.ts"] as string[],
  writingInstructions: XIAOHONGSHU_CASE_WRITING_INSTRUCTIONS,
  instructions: `${XIAOHONGSHU_CASE_WRITING_INSTRUCTIONS}\n上传阶段只能由 Chrome 扩展保存到草稿箱，严禁触发正式发布。`,
} as const;
