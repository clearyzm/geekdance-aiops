import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  applyGeekDanceWechatCoverStyle,
  createGeekDanceWechatFallbackCover,
  shouldCreateWechatFallbackCover,
  WECHAT_COVER_BRAND_TEXT,
  WECHAT_COVER_STYLE_VERSION,
  WECHAT_COVER_HEIGHT,
  WECHAT_COVER_CROPS,
} from "../src/wechat-cover.js";

describe("GeekDance WeChat cover", () => {
  it("keeps mock drafts offline even when mock materials expose placeholder URLs", () => {
    expect(
      shouldCreateWechatFallbackCover({
        publisherMode: "mock",
        coverImageUrl: "https://mock.geekhome.local/material-1.jpg",
      }),
    ).toBe(true);
    expect(
      shouldCreateWechatFallbackCover({
        publisherMode: "live",
        coverImageUrl: "https://home.geekdance.app/real-cover.jpg",
      }),
    ).toBe(false);
    expect(
      shouldCreateWechatFallbackCover({
        publisherMode: "mock",
        coverImageUrl: "https://mock.geekhome.local/material-1.jpg",
        existingCoverMediaId: "existing-media",
      }),
    ).toBe(false);
  });
  const lockupUrl = new URL(
    "../../web/public/brand/geekdance-cover-lockup.png",
    import.meta.url,
  );

  it("creates a valid branded fallback when the article has no image", async () => {
    const fallback = await createGeekDanceWechatFallbackCover(
      "企业软件项目如何降低返工",
      new Uint8Array(await readFile(lockupUrl)),
    );
    const metadata = await sharp(fallback.buffer).metadata();

    expect(fallback.mime).toBe("image/jpeg");
    expect({ width: metadata.width, height: metadata.height }).toEqual({
      width: 900,
      height: WECHAT_COVER_HEIGHT,
    });
    expect(fallback.buffer.byteLength).toBeGreaterThan(10_000);
  });

  it("creates one branded master image with square and 2.35:1 crop regions", async () => {
    const source = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: "#f7f7f7",
      },
    })
      .png()
      .toBuffer();
    const styled = await applyGeekDanceWechatCoverStyle(
      new Uint8Array(source),
      new Uint8Array(await readFile(lockupUrl)),
    );
    const { data, info } = await sharp(styled.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
    };

    expect({ width: info.width, height: info.height }).toEqual({
      width: 900,
      height: WECHAT_COVER_HEIGHT,
    });
    expect(WECHAT_COVER_BRAND_TEXT).toBe("GeekDance");
    expect(WECHAT_COVER_STYLE_VERSION).toBe(
      "geekdance-real-photo-stacked-dual-crop-v16",
    );
    const clearTop = pixel(850, 24);
    expect(clearTop[0]).toBeGreaterThan(clearTop[1] + 20);
    expect(clearTop[0]).toBeGreaterThan(clearTop[2] + 20);
    const squareBottom = pixel(450, 860);
    expect(squareBottom[0]).toBeGreaterThan(squareBottom[1] + 5);
    expect(squareBottom[0]).toBeGreaterThan(squareBottom[2] + 5);
    expect(styled.crops).toEqual(WECHAT_COVER_CROPS);
    expect(styled.crops.square).toBe("0_0.298519_1_1");
    expect(styled.crops.wide).toBe("0_0_1_0.298519");

    const wordmarkRegion = await sharp(styled.buffer)
      .extract({ left: 50, top: 10, width: 800, height: 210 })
      .stats();
    expect(wordmarkRegion.channels[1]!.stdev).toBeGreaterThan(8);
  });

  it("uses independent operator-selected regions for wide and square covers", async () => {
    const source = await sharp({
      create: {
        width: 1000,
        height: 600,
        channels: 3,
        background: "#00aa33",
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 500,
              height: 600,
              channels: 3,
              background: "#2244dd",
            },
          })
            .png()
            .toBuffer(),
          left: 500,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const styled = await applyGeekDanceWechatCoverStyle(
      new Uint8Array(source),
      undefined,
      new Uint8Array(source),
      {
        wide: { x: 0.5, y: 0.2, width: 0.5, height: 0.354 },
        square: { x: 0, y: 0, width: 0.5, height: 0.833 },
      },
    );
    const { data, info } = await sharp(styled.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
    };
    const widePixel = pixel(450, 330);
    const squarePixel = pixel(450, 1080);
    expect(widePixel[2]).toBeGreaterThan(widePixel[1]);
    expect(squarePixel[1]).toBeGreaterThan(squarePixel[2]);
  });
});
