import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  MemoryWechatTokenStore,
  validateWechatDraftFields,
  validateWechatDraftHtml,
  WechatOfficialPublisher,
  WechatPublisherError,
} from "../src/index.js";

const html = `<section data-gd-root="article" style="color:#333"><p style="line-height:1.8">正文</p><section data-gd-promo-version="text-v2"><img src="/brand/geekdance-logo.png" alt="极客跳动" style="width:146px" /><img src="/brand/geekdance-contact-qr.png" alt="二维码" style="width:148px" /></section></section>`;
const input = {
  operationId: "11111111-1111-4111-8111-111111111111",
  confirmDraft: true,
  title: "企业如何让 AI Agent 进入业务流程",
  digest: "从目标、资料、权限和审核机制出发，检查 AI Agent 的落地条件。",
  contentHtml: html,
  coverImageUrl: "https://assets.example/cover.png",
};

describe("WeChat official account publisher", () => {
  it("validates field limits and rejects unsafe HTML", () => {
    expect(() =>
      validateWechatDraftFields({ ...input, title: "标".repeat(33) }),
    ).toThrow(WechatPublisherError);
    expect(() =>
      validateWechatDraftHtml(`${html}<script>alert(1)</script>`),
    ).toThrow(WechatPublisherError);
  });

  it("returns a draft-only result in mock mode", async () => {
    const publisher = new WechatOfficialPublisher({
      mode: "mock",
      allowProduction: false,
      promoBoardPath: "/unused",
    });
    const result = await publisher.createDraft(input);
    expect(result.status).toBe("draft");
    expect(result.id).toContain("mock-wechat-");
    expect(result.mock).toBe(true);
  });

  it("requires both live production switches", async () => {
    const publisher = new WechatOfficialPublisher({
      mode: "live",
      allowProduction: false,
      appId: "app",
      appSecret: "secret",
      promoBoardPath: "/unused",
    });
    await expect(publisher.createDraft(input)).rejects.toMatchObject({
      code: "WECHAT_DRAFT_NOT_CONFIRMED",
    });
  });

  it("uploads every body image before creating a draft and reuses the cached token", async () => {
    let tokenCalls = 0;
    let uploadedContent = "";
    let uploadedAuthor = "";
    let uploadedCrops: { square?: string; wide?: string } = {};
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/cgi-bin/token")) {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({ access_token: "token-1", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (value.includes("/cgi-bin/media/uploadimg"))
        return new Response(
          JSON.stringify({ url: "https://mmbiz.qpic.cn/content-image" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (value.includes("/cgi-bin/draft/add")) {
        const payload = JSON.parse(String(init?.body)) as {
          articles: Array<{
            author: string;
            content: string;
            pic_crop_1_1?: string;
            pic_crop_235_1?: string;
          }>;
        };
        uploadedContent = payload.articles[0]!.content;
        uploadedAuthor = payload.articles[0]!.author;
        uploadedCrops = {
          square: payload.articles[0]!.pic_crop_1_1,
          wide: payload.articles[0]!.pic_crop_235_1,
        };
        return new Response(JSON.stringify({ media_id: "draft-media-id" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${value}`);
    });
    const publisher = new WechatOfficialPublisher({
      mode: "live",
      allowProduction: true,
      appId: "app",
      appSecret: "secret",
      promoBoardPath: fileURLToPath(
        new URL(
          "../../../apps/web/public/brand/geekdance-promo-board.png",
          import.meta.url,
        ),
      ),
      brandLogoPath: fileURLToPath(
        new URL(
          "../../../apps/web/public/brand/geekdance-logo.png",
          import.meta.url,
        ),
      ),
      contactQrPath: fileURLToPath(
        new URL(
          "../../../apps/web/public/brand/geekdance-contact-qr.png",
          import.meta.url,
        ),
      ),
      tokenStore: new MemoryWechatTokenStore(),
      fetcher: fetcher as typeof fetch,
    });
    const result = await publisher.createDraft({
      ...input,
      existingCoverMediaId: "existing-cover",
      coverImageData: {
        buffer: new Uint8Array([1]),
        mime: "image/jpeg",
        crops: { square: "0_0_1_0.7", wide: "0_0.7_1_1" },
      },
    });
    expect(result.id).toBe("draft-media-id");
    expect(tokenCalls).toBe(1);
    expect(uploadedContent).toContain("https://mmbiz.qpic.cn/content-image");
    expect(uploadedContent).not.toContain("/brand/geekdance-logo.png");
    expect(uploadedContent).not.toContain("/brand/geekdance-contact-qr.png");
    expect(uploadedAuthor).toBe("极客跳动编辑部");
    expect(uploadedCrops).toEqual({
      square: "0_0_1_0.7",
      wide: "0_0.7_1_1",
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
