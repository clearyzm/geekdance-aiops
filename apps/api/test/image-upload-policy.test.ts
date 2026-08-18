import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("image upload timeout policy", () => {
  it("returns after local persistence without waiting for large blob backup", async () => {
    const source = await readFile(
      new URL("../src/image-routes.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("function backupAssetBlob");
    expect(source).toContain("void db");
    expect(source).not.toMatch(
      /await db\.query\(\s*["']INSERT INTO asset_blobs/,
    );
    expect(source).toContain("void mirrorAssetToStore");
  });

  it("compresses large WeChat covers before upload", async () => {
    const source = await readFile(
      new URL("../../web/app/(portal)/tasks/[jobId]/page.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("optimizeWechatCoverUpload");
    expect(source).toContain('canvas.toBlob(resolve, "image/jpeg", 0.9)');
    expect(source).toContain("HTTP 524");
  });
});
