import { describe, expect, it } from "vitest";
import {
  deliveryResultMatchesMode,
  formalPublishConfirmed,
  summarizeDeliveryItems,
} from "../src/multi-account-delivery-policy.js";

describe("multi-account delivery policy", () => {
  it("keeps each account independent and reports a partial batch", () => {
    expect(summarizeDeliveryItems(["drafted", "failed", "drafted"])).toBe(
      "partial",
    );
  });

  it("never turns an ambiguous account into an automatic retry state", () => {
    expect(summarizeDeliveryItems(["drafted", "ambiguous"])).toBe("ambiguous");
  });

  it("does not report filled but unsaved editors as completed drafts", () => {
    expect(summarizeDeliveryItems(["filled", "filled"])).toBe("manual_review");
  });

  it("requires an exact reviewed title and explicit confirmation", () => {
    expect(
      formalPublishConfirmed({
        reviewConfirmed: true,
        confirmTitle: "已复核文章",
        reviewedTitle: "已复核文章",
      }),
    ).toBe(true);
    expect(
      formalPublishConfirmed({
        reviewConfirmed: true,
        confirmTitle: "另一篇文章",
        reviewedTitle: "已复核文章",
      }),
    ).toBe(false);
  });

  it("rejects a result that crosses the authorized mode", () => {
    expect(deliveryResultMatchesMode("draft", "published")).toBe(false);
    expect(deliveryResultMatchesMode("publish", "drafted")).toBe(false);
    expect(deliveryResultMatchesMode("publish", "published")).toBe(true);
  });
});
