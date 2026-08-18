import { afterEach, describe, expect, it, vi } from "vitest";
import { createOssAssetStore } from "../src/index.js";

describe("OSS asset store", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uploads objects to the bucket host with an OSS signature", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createOssAssetStore({
      endpoint: "https://oss-ap-southeast-1.aliyuncs.com",
      bucket: "geekdance-aiops",
      prefix: "ai-ops",
      accessKeyId: "test-id",
      accessKeySecret: "test-secret",
    })!;

    await store.put(
      "11111111-1111-4111-8111-111111111111.jpg",
      new Uint8Array([0xff, 0xd8, 0xff]),
      "image/jpeg",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://geekdance-aiops.oss-ap-southeast-1.aliyuncs.com/ai-ops/11111111-1111-4111-8111-111111111111.jpg",
    );
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("authorization")).toMatch(
      /^OSS test-id:/,
    );
  });

  it("creates a short-lived signed download URL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T08:00:00Z"));
    const store = createOssAssetStore({
      endpoint: "https://oss-ap-southeast-1.aliyuncs.com",
      bucket: "geekdance-aiops",
      prefix: "ai-ops",
      accessKeyId: "test-id",
      accessKeySecret: "test-secret",
    })!;

    const url = new URL(store.signedUrl("asset.jpg", 900));
    expect(url.hostname).toBe(
      "geekdance-aiops.oss-ap-southeast-1.aliyuncs.com",
    );
    expect(url.pathname).toBe("/ai-ops/asset.jpg");
    expect(url.searchParams.get("OSSAccessKeyId")).toBe("test-id");
    expect(url.searchParams.get("Expires")).toBe("1784967300");
    expect(url.searchParams.get("Signature")).toBeTruthy();
  });
});
