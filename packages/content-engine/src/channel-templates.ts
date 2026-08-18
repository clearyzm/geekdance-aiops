import type { Channel } from "@geekdance/shared";
import { z } from "zod";
import snapshots from "./channel-template-snapshots.json" with { type: "json" };
import { XIAOHONGSHU_TEMPLATE } from "./xiaohongshu-template.js";
import { XIAOHONGSHU_CASE_TEMPLATE } from "./xiaohongshu-case-template.js";
import { BROWSER_ARTICLE_TEMPLATES } from "./browser-article-templates.js";

const templateSchema = z.object({
  skillName: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFiles: z.array(z.string()).min(1),
  writingInstructions: z.string().min(100),
  instructions: z.string().min(100),
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  templates: z.object({
    official_site: templateSchema,
    wechat: templateSchema,
  }),
});

const parsed = snapshotSchema.parse(snapshots);

export type ChannelTemplate = z.infer<typeof templateSchema> & {
  channel: Channel;
};

export type ChannelTemplateRef = Pick<
  ChannelTemplate,
  "channel" | "skillName" | "version" | "sourceHash"
>;

export function getChannelTemplate(
  channel: Channel,
  contentType: "general" | "case" = "general",
): ChannelTemplate {
  return templateSchema.extend({ channel: z.custom<Channel>() }).parse({
    channel,
    ...(channel === "xiaohongshu"
      ? contentType === "case"
        ? XIAOHONGSHU_CASE_TEMPLATE
        : XIAOHONGSHU_TEMPLATE
      : channel === "zhihu" ||
          channel === "toutiao" ||
          channel === "baijiahao" ||
          channel === "linkedin"
        ? BROWSER_ARTICLE_TEMPLATES[channel]
        : parsed.templates[channel]),
  });
}

export function getChannelTemplateRef(
  channel: Channel,
  contentType: "general" | "case" = "general",
): ChannelTemplateRef {
  const { skillName, version, sourceHash } = getChannelTemplate(
    channel,
    contentType,
  );
  return { channel, skillName, version, sourceHash };
}

export const CHANNEL_TEMPLATE_REFS = {
  official_site: getChannelTemplateRef("official_site"),
  wechat: getChannelTemplateRef("wechat"),
  xiaohongshu: getChannelTemplateRef("xiaohongshu"),
  zhihu: getChannelTemplateRef("zhihu"),
  toutiao: getChannelTemplateRef("toutiao"),
  baijiahao: getChannelTemplateRef("baijiahao"),
  linkedin: getChannelTemplateRef("linkedin"),
} as const;
