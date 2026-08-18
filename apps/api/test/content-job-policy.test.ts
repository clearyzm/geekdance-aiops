import { describe, expect, it } from "vitest";
import {
  cancellableJobStatuses,
  cancellableTargetStatuses,
  cancellationUnsafeTargetStatuses,
  contentGenerationActiveStatuses,
  summarizeContentJobTargets,
} from "../src/content-job-policy.js";

describe("content job cancellation policy", () => {
  it("does not count extension waiting time as active content generation", () => {
    expect(contentGenerationActiveStatuses).not.toContain("awaiting_upload");
    expect(cancellableJobStatuses).toContain("awaiting_upload");
  });

  it("cancels only targets that have not started an external write", () => {
    expect(cancellableTargetStatuses).toContain("waiting_for_uploader");
    expect(cancellableTargetStatuses).not.toContain("drafted");
    expect(cancellationUnsafeTargetStatuses).toEqual([
      "publishing",
      "uploading",
    ]);
  });

  it("preserves completed drafts when Xiaohongshu upload is cancelled", () => {
    expect(
      summarizeContentJobTargets(["drafted", "drafted", "cancelled"]),
    ).toEqual({
      status: "partial",
      message: "已创建的渠道草稿保持不变，其余渠道任务已取消",
    });
  });

  it("marks a fully cancelled job as cancelled", () => {
    expect(summarizeContentJobTargets(["cancelled", "cancelled"])).toEqual({
      status: "cancelled",
      message: "任务已取消",
    });
  });

  it("distinguishes completed form filling from a saved Xiaohongshu draft", () => {
    expect(summarizeContentJobTargets(["drafted", "filled"])).toEqual({
      status: "awaiting_manual_save",
      message: "平台内容已填写完成，请在对应创作页面检查并人工保存草稿",
    });
  });
});
