import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeHtmlImageUrl,
  OfficialPublisherError,
  OfficialSitePublisher,
  validateOfficialHtml,
} from "../src/index.js";

const validHtml = `<div data-gd-root="website-article" style="color:#333"><h2 data-gd-section="01" style="color:#E52521">一</h2><p style="color:#333">正文</p><h2 data-gd-section="02" style="color:#E52521">二</h2><p style="color:#333">正文</p><h2 data-gd-section="03" style="color:#E52521">三</h2><p style="color:#333">正文</p><p style="color:#E52521">重点</p><p style="color:#333">说明</p><p style="color:#333">说明</p><p style="color:#333">说明</p><blockquote data-gd-callout="observation" style="border:1px solid #E52521">观察</blockquote><div data-gd-conclusion="editorial" style="color:#333">结论</div></div>`;

describe("official site publisher", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accepts the inline GeekDance website artifact", () => {
    expect(validateOfficialHtml(validHtml).sections).toBe(3);
  });

  it("rejects scripts and a complete WeChat promotion board", () => {
    expect(() =>
      validateOfficialHtml(`${validHtml}<script>alert(1)</script>`),
    ).toThrow(OfficialPublisherError);
    expect(() =>
      validateOfficialHtml(
        validHtml.replace(
          "结论",
          '<div class="geekdance-promo-board">关于我们 · 主营业务 · 联系方式</div>',
        ),
      ),
    ).toThrow(OfficialPublisherError);
  });

  it("allows ordinary article copy that mentions contact information", () => {
    expect(
      validateOfficialHtml(
        validHtml.replace("正文", "提交资料前请删除不合规联系方式"),
      ).sections,
    ).toBe(3);
  });

  it("returns a deterministic draft result in mock mode", async () => {
    const publisher = new OfficialSitePublisher({
      mode: "mock",
      baseUrl: "https://www.geekdance.cn",
      allowProduction: false,
    });
    const result = await publisher.createDraft({
      operationId: "11111111-1111-4111-8111-111111111111",
      confirmDraft: true,
      title: "自动化验收文章",
      description: "用于本地测试的描述信息，不会写入任何真实系统。",
      contentHtml: validHtml,
    });
    expect(result.status).toBe("draft");
    expect(result.mock).toBe(true);
  });

  it("requires both production switches before a live write", async () => {
    const publisher = new OfficialSitePublisher({
      mode: "live",
      baseUrl: "https://www.geekdance.cn",
      allowProduction: false,
    });
    await expect(
      publisher.createDraft({
        operationId: "11111111-1111-4111-8111-111111111111",
        confirmDraft: true,
        title: "自动化验收文章",
        description: "用于本地测试的描述信息，不会写入任何真实系统。",
        contentHtml: validHtml,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_DRAFT_NOT_CONFIRMED" });
  });

  it("treats upstream 5xx after draft submission as ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "upstream failed" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const publisher = new OfficialSitePublisher({
      mode: "live",
      baseUrl: "https://www.geekdance.cn",
      allowProduction: true,
      bearerToken: "test-token",
    });
    await expect(
      publisher.createDraft({
        operationId: "11111111-1111-4111-8111-111111111111",
        confirmDraft: true,
        title: "自动化验收文章",
        description: "用于验证上游异常不会触发可能重复的自动重试。",
        contentHtml: validHtml,
      }),
    ).rejects.toMatchObject({
      code: "OFFICIAL_WRITE_AMBIGUOUS",
      ambiguous: true,
    });
  });

  it("refreshes an expired CMS login token before creating the draft", async () => {
    const authorizationHeaders: string[] = [];
    let loginCount = 0;
    let draftAttempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/admin/auth/password/login")) {
          loginCount += 1;
          return new Response(
            JSON.stringify({
              code: 200,
              data: {
                token: loginCount === 1 ? "expired-token" : "fresh-token",
              },
            }),
            { status: 200 },
          );
        }
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Authorization)
          authorizationHeaders.push(headers.Authorization);
        if (
          url.pathname.endsWith("/admin/articles") &&
          init?.method === "POST"
        ) {
          draftAttempt += 1;
          if (draftAttempt === 1)
            return new Response(
              JSON.stringify({ code: 401, message: "token expired" }),
              { status: 401 },
            );
          return new Response(
            JSON.stringify({ code: 200, data: { id: "draft-1" } }),
            { status: 200 },
          );
        }
        if (
          url.pathname.endsWith("/admin/articles/draft-1/batch") &&
          init?.method === "PUT"
        )
          return new Response(JSON.stringify({ code: 200 }), { status: 200 });
        throw new Error(`unexpected request: ${url.pathname}`);
      }),
    );
    const publisher = new OfficialSitePublisher({
      mode: "live",
      baseUrl: "https://www.geekdance.cn",
      allowProduction: true,
      username: "publisher",
      password: "secret",
    });
    const result = await publisher.createDraft({
      operationId: "11111111-1111-4111-8111-111111111111",
      confirmDraft: true,
      title: "自动化验收文章",
      description: "用于验证官网登录凭据到期后可以安全刷新并继续创建草稿。",
      contentHtml: validHtml,
    });
    expect(result.id).toBe("draft-1");
    expect(loginCount).toBe(2);
    expect(authorizationHeaders).toEqual([
      "Bearer expired-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
    ]);
  });

  it("marks an interrupted batch save as ambiguous after the draft was created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/admin/articles") && init?.method === "POST")
          return new Response(
            JSON.stringify({ code: 200, data: { id: "draft-ambiguous" } }),
            { status: 200 },
          );
        if (url.pathname.endsWith("/batch") && init?.method === "PUT")
          throw new TypeError("connection reset");
        throw new Error(`unexpected request: ${url.pathname}`);
      }),
    );
    const publisher = new OfficialSitePublisher({
      mode: "live",
      baseUrl: "https://www.geekdance.cn",
      allowProduction: true,
      bearerToken: "test-token",
    });
    await expect(
      publisher.createDraft({
        operationId: "11111111-1111-4111-8111-111111111111",
        confirmDraft: true,
        title: "自动化验收文章",
        description: "用于验证草稿创建后批量保存中断不会被当作可安全重试。",
        contentHtml: validHtml,
      }),
    ).rejects.toMatchObject({
      code: "OFFICIAL_BATCH_SAVE_AMBIGUOUS",
      ambiguous: true,
    });
  });

  it("decodes signed image query separators escaped by HTML formatting", () => {
    expect(
      decodeHtmlImageUrl(
        "https://assets.example/image.png?key=one&amp;Expires=2&#38;Signature=3&#x26;v=4",
      ),
    ).toBe(
      "https://assets.example/image.png?key=one&Expires=2&Signature=3&v=4",
    );
  });
});
