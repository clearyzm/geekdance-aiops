import { describe, expect, it } from "vitest";
import type { WorkerRuntimeSnapshot } from "@geekdance/shared";
import { workerReleaseMatches } from "../src/release-health.js";

const runtime = (release: string): WorkerRuntimeSnapshot => ({
  release,
  recordedAt: new Date().toISOString(),
  contentEngineMode: "openai",
  imageProviderMode: "openai",
  officialPublisherMode: "live",
  officialAllowProduction: true,
  wechatPublisherMode: "live",
  wechatAllowProduction: true,
  textModel: "gpt-5.6-sol",
  imageModel: "gpt-image-2",
  textKeyConfigured: true,
  imageKeyConfigured: true,
  geekHomeConfigured: true,
  assetPublicSecretConfigured: true,
});

describe("release health", () => {
  it("accepts a worker from the same deployment", () => {
    expect(workerReleaseMatches("release-123", runtime("release-123"))).toBe(
      true,
    );
  });

  it("rejects an absent or stale worker deployment", () => {
    expect(workerReleaseMatches("release-123", null)).toBe(false);
    expect(workerReleaseMatches("release-123", runtime("release-122"))).toBe(
      false,
    );
  });
});
