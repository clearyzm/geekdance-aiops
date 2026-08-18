import { describe, expect, it } from "vitest";
import { firstNonEmpty } from "../src/runtime-config.js";

describe("worker runtime configuration", () => {
  it("falls back to the unified key when a dedicated key is empty", () => {
    expect(firstNonEmpty("", "  ", "sk-or-unified")).toBe("sk-or-unified");
  });

  it("prefers and trims a non-empty dedicated key", () => {
    expect(firstNonEmpty("  sk-or-text  ", "sk-or-unified")).toBe("sk-or-text");
  });
});
