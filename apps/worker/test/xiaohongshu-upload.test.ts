import { describe, expect, it } from "vitest";
import { resolveXiaohongshuUploadImages } from "../src/xiaohongshu-upload.js";

describe("Xiaohongshu upload images", () => {
  it("uses the final reviewed artifact images when present", () => {
    expect(
      resolveXiaohongshuUploadImages(
        [
          {
            selected: {
              id: "reviewed-1",
              url: "https://aiops.geekdance.cn/reviewed.jpg",
              title: "复核封面",
            },
          },
        ],
        [
          {
            id: "generated-1",
            url: "https://aiops.geekdance.cn/generated.jpg",
          },
        ],
      ),
    ).toEqual([
      {
        id: "reviewed-1",
        url: "https://aiops.geekdance.cn/reviewed.jpg",
        title: "复核封面",
      },
    ]);
  });

  it("restores full automation with generated candidates after an image-free review", () => {
    expect(
      resolveXiaohongshuUploadImages(
        [{ selected: null }],
        [
          {
            id: "generated-1",
            url: "https://aiops.geekdance.cn/generated-1.jpg",
            title: "章节结构图",
          },
          {
            id: "generated-2",
            url: "https://aiops.geekdance.cn/generated-2.jpg",
          },
        ],
      ),
    ).toEqual([
      {
        id: "generated-1",
        url: "https://aiops.geekdance.cn/generated-1.jpg",
        title: "章节结构图",
      },
      {
        id: "generated-2",
        url: "https://aiops.geekdance.cn/generated-2.jpg",
        title: "AI 章节插图",
      },
    ]);
  });

  it("never emits duplicate URLs", () => {
    expect(
      resolveXiaohongshuUploadImages(
        [],
        [
          { id: "one", url: "https://aiops.geekdance.cn/same.jpg" },
          { id: "two", url: "https://aiops.geekdance.cn/same.jpg" },
        ],
      ),
    ).toHaveLength(1);
  });
});
