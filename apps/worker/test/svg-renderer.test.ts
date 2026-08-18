import { describe, expect, it } from "vitest";
import {
  applyGeneratedImageTypography,
  GENERATED_IMAGE_LETTER_SPACING,
} from "../src/svg-renderer.js";

describe("generated image typography", () => {
  it("adds restrained tracking without replacing an explicit spacing rule", () => {
    const svg = applyGeneratedImageTypography(
      '<svg><text x="10">正文</text><text letter-spacing="3">品牌文字</text></svg>',
    );
    expect(svg).toContain(
      `<text x="10" letter-spacing="${GENERATED_IMAGE_LETTER_SPACING}">正文</text>`,
    );
    expect(svg).toContain('<text letter-spacing="3">品牌文字</text>');
  });
});
