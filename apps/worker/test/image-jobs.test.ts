import { afterEach, describe, expect, it, vi } from "vitest";
import { imageJobRequestSchema } from "@geekdance/shared";
import {
  generateAiImages,
  generateOpenRouterImages,
} from "../src/image-jobs.js";

describe("OpenRouter image requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults new image requests to high quality", () => {
    const input = imageJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "generate",
      prompt: "运营团队正在审核自动化内容任务",
      rightsConfirmed: true,
    });

    expect(input.quality).toBe("high");
  });

  it("accepts bounded manual crop regions and rejects overflow", () => {
    const base = {
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "crop",
      sourceAssetIds: ["22222222-2222-4222-8222-222222222222"],
      ratio: "4:3",
      cropRegion: { x: 0.1, y: 0.15, width: 0.7, height: 0.6 },
    } as const;

    expect(imageJobRequestSchema.safeParse(base).success).toBe(true);
    expect(
      imageJobRequestSchema.safeParse({
        ...base,
        cropRegion: { ...base.cropRegion, x: 0.5, width: 0.7 },
      }).success,
    ).toBe(false);
  });

  it("uses Image API reference fields and maps standard quality to medium", async () => {
    let submitted: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        submitted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: [
              {
                b64_json: Buffer.from([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                ]).toString("base64"),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const input = imageJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "compose",
      sourceAssetIds: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
      quality: "standard",
      rightsConfirmed: true,
    });
    await generateOpenRouterImages(
      {
        openRouterApiKey: "test-key",
        openRouterBaseUrl: "https://openrouter.example",
        model: "openai/gpt-5.4-image-2",
        allowedResultHosts: [],
      },
      input,
      [
        { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" },
        { bytes: new Uint8Array([4, 5, 6]), mime: "image/jpeg" },
      ],
    );
    expect(submitted.quality).toBe("medium");
    expect(submitted.aspect_ratio).toBe("16:9");
    expect(submitted.resolution).toBe("1K");
    expect(submitted.output_format).toBe("png");
    expect(submitted).not.toHaveProperty("images");
    expect(submitted.input_references).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AQID" },
      },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,BAUG" },
      },
    ]);
  });

  it("uses the official OpenAI Images API and gpt-image-2 fields", async () => {
    let requestedUrl = "";
    let submitted: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requestedUrl = String(url);
        submitted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: [
              {
                b64_json: Buffer.from([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                ]).toString("base64"),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const input = imageJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "generate",
      prompt: "运营团队正在审核自动化内容任务",
      ratio: "16:9",
      quality: "high",
      rightsConfirmed: true,
    });

    await generateAiImages(
      {
        providerMode: "openai",
        imageApiKey: "test-openai-key",
        imageBaseUrl: "https://api.openai.example/v1",
        model: "gpt-image-2",
        allowedResultHosts: [],
      },
      input,
      [],
    );

    expect(requestedUrl).toBe(
      "https://api.openai.example/v1/images/generations",
    );
    expect(submitted).toMatchObject({
      model: "gpt-image-2",
      n: 1,
      quality: "high",
      size: "1536x864",
      output_format: "png",
    });
    expect(submitted).not.toHaveProperty("aspect_ratio");
    expect(submitted).not.toHaveProperty("resolution");
  });

  it("sends a purpose-built article illustration prompt without the scene wrapper", async () => {
    let submitted: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        submitted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: [
              {
                b64_json: Buffer.from([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                ]).toString("base64"),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const input = imageJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "generate",
      prompt: "schema fallback prompt",
      ratio: "4:3",
      quality: "high",
      rightsConfirmed: true,
    });
    const promptOverride =
      "4:3 白底辅助理解型信息插图；只表达订单流转关系；顶部留出标题和 Logo 安全区";

    await generateAiImages(
      {
        providerMode: "openai",
        imageApiKey: "test-openai-key",
        imageBaseUrl: "https://api.openai.example/v1",
        model: "gpt-image-2",
        allowedResultHosts: [],
        promptOverride,
      },
      input,
      [],
    );

    expect(submitted.prompt).toBe(promptOverride);
    expect(submitted.size).toBe("1536x1152");
    expect(String(submitted.prompt)).not.toContain(
      "specific, observable business moment",
    );
  });

  it("uses the official OpenAI JSON edits endpoint for reference images", async () => {
    let requestedUrl = "";
    let submitted: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requestedUrl = String(url);
        submitted = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: [
              {
                b64_json: Buffer.from([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                ]).toString("base64"),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const input = imageJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "compose",
      sourceAssetIds: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
      quality: "standard",
      rightsConfirmed: true,
    });

    await generateAiImages(
      {
        providerMode: "openai",
        imageApiKey: "test-openai-key",
        imageBaseUrl: "https://api.openai.example/v1",
        model: "gpt-image-2",
        allowedResultHosts: [],
      },
      input,
      [
        { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" },
        { bytes: new Uint8Array([4, 5, 6]), mime: "image/jpeg" },
      ],
    );

    expect(requestedUrl).toBe("https://api.openai.example/v1/images/edits");
    expect(submitted.images).toEqual([
      { image_url: "data:image/png;base64,AQID" },
      { image_url: "data:image/jpeg;base64,BAUG" },
    ]);
    expect(String(submitted.prompt)).toContain(
      "Automatically choose the person's position, scale and crop",
    );
    expect(String(submitted.prompt)).not.toContain(
      "right side at approximately 62%",
    );
  });

  it("caps concurrent provider requests at three without serializing the whole batch", async () => {
    const releases: Array<() => void> = [];
    let activeRequests = 0;
    let peakActiveRequests = 0;
    const fetchMock = vi.fn(async () => {
      activeRequests += 1;
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeRequests -= 1;
      return new Response(
        JSON.stringify({
          data: [
            {
              b64_json: Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              ]).toString("base64"),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = imageJobRequestSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      operation: "generate",
      prompt: "运营团队正在审核自动化内容任务",
      rightsConfirmed: true,
    });
    const options = {
      openRouterApiKey: "test-key",
      openRouterBaseUrl: "https://openrouter.example",
      model: "openai/gpt-5.4-image-2",
      allowedResultHosts: [],
    };

    const requests = Array.from({ length: 4 }, () =>
      generateOpenRouterImages(options, input, []),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(peakActiveRequests).toBe(3);
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    while (releases.length) releases.shift()?.();
    await Promise.all(requests);

    expect(peakActiveRequests).toBe(3);
  });
});
