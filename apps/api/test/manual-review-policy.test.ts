import { describe, expect, it } from "vitest";
import {
  reviewCategory,
  reviewDecisionAllowed,
  reviewDecisionPlan,
  reviewedArtifactIsUsable,
  reviewReason,
} from "../src/manual-review-policy.js";

describe("manual review policy", () => {
  it("derives content and delivery review categories", () => {
    expect(
      reviewCategory({
        target: "wechat",
        result: { contentStatus: "blocked", channelArtifacts: {} },
      }),
    ).toBe("content_quality");
    expect(
      reviewCategory({
        target: "xiaohongshu",
        error_code: "CONTENT_REVIEW_REQUIRED",
        result: { contentStatus: "ready", channelArtifacts: {} },
      }),
    ).toBe("content_quality");
    expect(
      reviewCategory({
        target: "wechat",
        result: { contentStatus: "ready", channelArtifacts: {} },
      }),
    ).toBe("delivery_uncertain");
    expect(
      reviewCategory({
        target: "official_site",
        error_code: "GEEKHOME_SELECTION_REQUIRED",
        result: { contentStatus: "ready", channelArtifacts: {} },
      }),
    ).toBe("content_quality");
  });

  it("shows an actionable reason while preserving the reason code separately", () => {
    expect(
      reviewReason({
        target: "wechat",
        error_code: "CHANNEL_CONTENT_REVIEW_REQUIRED",
        result: {
          manualReviewReason: "标题表述需要运营人员确认",
          channelArtifacts: {},
        },
      }),
    ).toBe("标题表述需要运营人员确认");
    expect(
      reviewReason({
        target: "xiaohongshu",
        error_code: "UPLOAD_CLAIM_EXPIRED",
        result: { channelArtifacts: {} },
      }),
    ).toContain("对应平台创作中心核对");
  });

  it("accepts only decisions valid for the review category", () => {
    expect(reviewDecisionAllowed("content_quality", "approve_content")).toBe(
      true,
    );
    expect(reviewDecisionAllowed("content_quality", "confirm_drafted")).toBe(
      false,
    );
    expect(
      reviewDecisionAllowed("delivery_uncertain", "confirm_absent_retry"),
    ).toBe(true);
    expect(reviewDecisionAllowed("delivery_uncertain", "reject_content")).toBe(
      false,
    );
  });

  it("requires a complete saved artifact before content approval", () => {
    expect(
      reviewedArtifactIsUsable(
        {
          article: { title: "案例" },
          officialSiteHtml: "<article>案例</article>",
          channelArtifacts: {
            official_site: {
              status: "manual_review",
              article: { title: "案例" },
              html: "<article>案例</article>",
            },
          },
        },
        "official_site",
      ),
    ).toBe(true);
    expect(
      reviewedArtifactIsUsable(
        {
          channelArtifacts: {
            xiaohongshu: { note: { title: "案例", body: "" } },
          },
        },
        "xiaohongshu",
      ),
    ).toBe(false);
  });

  it("queues only approval/retry while confirmation performs no external write", () => {
    expect(reviewDecisionPlan("approve_content")).toMatchObject({
      queuesReviewedTarget: true,
      performsImmediateExternalWrite: false,
    });
    expect(reviewDecisionPlan("confirm_drafted")).toEqual({
      queuesReviewedTarget: false,
      performsImmediateExternalWrite: false,
      requiresChannelAbsenceConfirmation: false,
      updatesInternalStatusOnly: true,
    });
    expect(reviewDecisionPlan("confirm_absent_retry")).toMatchObject({
      queuesReviewedTarget: true,
      requiresChannelAbsenceConfirmation: true,
    });
  });
});
