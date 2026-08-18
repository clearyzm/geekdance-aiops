import { describe, expect, it } from "vitest";
import { resolveReviewMaterialCandidate } from "../src/manual-review-suggestion.js";

describe("manual review GeekHome suggestions", () => {
  it("resolves a material by stable id when its signed URL rotates", () => {
    const candidate = {
      id: "material-1",
      title: "企业数字化转型",
      url: "https://cdn.example.com/image.jpg?signature=new",
    };

    expect(
      resolveReviewMaterialCandidate([candidate], {
        materialId: "material-1",
        url: "https://cdn.example.com/image.jpg?signature=old",
      }),
    ).toEqual(candidate);
  });

  it("keeps exact URL fallback for legacy candidates without an id", () => {
    const candidate = { url: "https://cdn.example.com/legacy.jpg" };
    expect(
      resolveReviewMaterialCandidate([candidate], {
        materialId: candidate.url,
        url: candidate.url,
      }),
    ).toEqual(candidate);
  });

  it("rejects a material that is no longer in the refreshed result", () => {
    expect(
      resolveReviewMaterialCandidate([], {
        materialId: "removed-material",
        url: "https://cdn.example.com/removed.jpg",
      }),
    ).toBeUndefined();
  });
});
