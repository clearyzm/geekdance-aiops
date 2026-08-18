import type { Channel } from "@geekdance/shared";

type BrowserArticleChannel = Extract<
  Channel,
  "zhihu" | "toutiao" | "baijiahao" | "linkedin"
>;

const common = `基于已核验资料创作极客跳动品牌文章。内容必须服务软件定制、数字化产品或 AI 产品开发决策，清楚解释需求、流程、MVP 与交付边界；不得虚构客户、数据、效果或个人经历。文章使用短段落、3-5 个清晰章节和克制的服务引导。`;

export const BROWSER_ARTICLE_TEMPLATES: Record<
  BrowserArticleChannel,
  {
    skillName: string;
    version: string;
    sourceHash: string;
    sourceFiles: string[];
    writingInstructions: string;
    instructions: string;
  }
> = {
  zhihu: {
    skillName: "gd-market-zhihu-article",
    version: "1.0.0",
    sourceHash:
      "1c3b8e5cf1fe95ca0922f3fa6f226a597fd39fe106e0c73db61cc1fb5f4be778",
    sourceFiles: ["src/browser-article-templates.ts"],
    writingInstructions: `${common} 知乎文章应先回答一个明确问题，以论证和解释为主，标题避免营销腔；段落可比社交平台更完整，结论必须说明适用边界。`,
    instructions:
      "输出知乎文章草稿，保留标题、摘要、正文层级、配图和话题建议。先进入人工复核，运营人员可修改文章与配图；通过后只写入当前浏览器已登录账号的知乎创作后台草稿。不读取密码或 Cookie，不调用非公开发布接口，不点击正式发布。",
  },
  toutiao: {
    skillName: "gd-market-toutiao-article",
    version: "1.0.0",
    sourceHash:
      "1f84da20399ecc21e1b709fd8a18538c1227734287591364ea275fcfa32ce1b2",
    sourceFiles: ["src/browser-article-templates.ts"],
    writingInstructions: `${common} 今日头条文章开场要快速说明读者场景，标题准确直接，正文信息密度高且便于移动端阅读；不要使用夸张标题或无依据的市场判断。`,
    instructions:
      "输出今日头条图文草稿，包含标题、摘要、正文、配图和分类建议。先进入人工复核，运营人员可修改文章与配图；通过后只写入当前浏览器已登录账号的今日头条创作后台草稿。不读取密码或 Cookie，不调用非公开发布接口，不点击正式发布。",
  },
  baijiahao: {
    skillName: "gd-market-baijiahao-article",
    version: "1.0.0",
    sourceHash:
      "12c77e273d31c39e0b60823c1dc1b13b1c653a3ba6c9ac2881d47cb47c6f7789",
    sourceFiles: ["src/browser-article-templates.ts"],
    writingInstructions: `${common} 百家号文章强调清晰的信息结构、可搜索的业务关键词与中性准确表达；标题与摘要不得堆砌关键词，正文避免未经证实的营销承诺。`,
    instructions:
      "输出百家号图文草稿，包含标题、摘要、正文、配图和分类建议。先进入人工复核，运营人员可修改文章与配图；通过后只写入当前浏览器已登录账号的百家号创作后台草稿。不读取密码或 Cookie，不调用非公开发布接口，不点击正式发布。",
  },
  linkedin: {
    skillName: "gd-market-linkedin-article",
    version: "1.0.0",
    sourceHash:
      "8dec2364682c9dd5ce3a8321948b65d16f79fbc3f9a8ff9add3162ce206e6d54",
    sourceFiles: ["src/browser-article-templates.ts"],
    writingInstructions: `${common} LinkedIn 文章面向企业决策者、产品负责人和技术管理者，以专业洞察、方法和可验证案例为主；段落简洁，允许中英双语，避免空泛励志或夸张营销，并在末尾给出 3-5 个相关话题标签。`,
    instructions:
      "输出 LinkedIn 图文文章，包含标题、摘要、正文、配图和 3-5 个话题标签。先进入人工复核，运营人员可修改文章与配图；通过后由当前浏览器已登录账号保存草稿，或在人工复核、账号核对、内容指纹和二次确认全部满足时正式发布。不读取密码或 Cookie，不调用非公开发布接口。",
  },
};
