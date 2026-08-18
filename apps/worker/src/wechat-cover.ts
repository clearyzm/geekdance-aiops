import sharp from "sharp";
import {
  GENERATED_IMAGE_FONT_FAMILY,
  renderGeneratedImageSvg,
} from "./svg-renderer.js";

export type WechatCoverRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WechatCoverRegions = {
  wide?: WechatCoverRegion;
  square?: WechatCoverRegion;
};

export const WECHAT_COVER_STYLE_VERSION =
  "geekdance-real-photo-stacked-dual-crop-v16";
export const WECHAT_COVER_BRAND_TEXT = "GeekDance";
export const WECHAT_COVER_WIDTH = 900;
export const WECHAT_COVER_HEIGHT = 1283;
export const WECHAT_COVER_WIDE_HEIGHT = 383;

// One uploaded master contains the two previews: 2.35:1 on top, 1:1 below.
export const WECHAT_COVER_CROPS = {
  square: `0_${(WECHAT_COVER_WIDE_HEIGHT / WECHAT_COVER_HEIGHT).toFixed(6)}_1_1`,
  wide: `0_0_1_${(WECHAT_COVER_WIDE_HEIGHT / WECHAT_COVER_HEIGHT).toFixed(6)}`,
} as const;

export function shouldCreateWechatFallbackCover(input: {
  existingCoverMediaId?: string;
  coverImageUrl?: string;
  publisherMode: "off" | "mock" | "live";
}) {
  return (
    !input.existingCoverMediaId &&
    (!input.coverImageUrl || input.publisherMode === "mock")
  );
}

const escapeXml = (value: string) =>
  value.replace(
    /[&<>\"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

function wechatBrandOverlay(width: number, height: number) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gd-cover-top-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#F01731" stop-opacity="0.50"/>
          <stop offset="32%" stop-color="#E60020" stop-opacity="0.32"/>
          <stop offset="68%" stop-color="#79000D" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#140003" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#gd-cover-top-gradient)"/>
    </svg>`,
  );
}

function websiteBrandOverlay(width: number, height: number) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="gd-website-cover-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F01731" stop-opacity="0.50"/><stop offset="32%" stop-color="#E60020" stop-opacity="0.32"/><stop offset="68%" stop-color="#79000D" stop-opacity="0.12"/><stop offset="100%" stop-color="#140003" stop-opacity="0"/></linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#gd-website-cover-gradient)"/>
    </svg>`,
  );
}

async function coverWordmark(
  brandLockup: Uint8Array | undefined,
  width: number,
  height: number,
) {
  if (!brandLockup?.byteLength) return undefined;
  const maximumWidth = Math.round(width * 0.88);
  const prepared = await sharp(Buffer.from(brandLockup))
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize({ width: maximumWidth, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = Buffer.from(prepared.data);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]!;
    if (!alpha) continue;
    pixels[index] = 255;
    pixels[index + 1] = 255;
    pixels[index + 2] = 255;
    pixels[index + 3] = Math.min(255, Math.round(alpha * 2.15));
  }
  return sharp(pixels, {
    raw: {
      width: prepared.info.width,
      height: prepared.info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function brandedCrop(
  source: Uint8Array,
  width: number,
  height: number,
  brandLockup?: Uint8Array,
  cropRegion?: WechatCoverRegion,
) {
  const wordmark = await coverWordmark(brandLockup, width, height);
  const wordmarkInfo = wordmark ? await sharp(wordmark).metadata() : undefined;
  const layers: Array<{
    input: Buffer;
    blend: "over";
    left?: number;
    top?: number;
  }> = [{ input: wechatBrandOverlay(width, height), blend: "over" }];
  if (wordmark)
    layers.push({
      input: wordmark,
      left: Math.round((width - (wordmarkInfo?.width ?? 0)) / 2),
      top: Math.max(12, Math.round(height * 0.035)),
      blend: "over",
    });
  const oriented = await sharp(source).rotate().toBuffer();
  const metadata = await sharp(oriented).metadata();
  const sourceWidth = metadata.width ?? width;
  const sourceHeight = metadata.height ?? height;
  const crop = cropRegion
    ? {
        left: Math.max(
          0,
          Math.min(sourceWidth - 1, Math.round(cropRegion.x * sourceWidth)),
        ),
        top: Math.max(
          0,
          Math.min(sourceHeight - 1, Math.round(cropRegion.y * sourceHeight)),
        ),
        width: Math.max(
          1,
          Math.min(sourceWidth, Math.round(cropRegion.width * sourceWidth)),
        ),
        height: Math.max(
          1,
          Math.min(sourceHeight, Math.round(cropRegion.height * sourceHeight)),
        ),
      }
    : undefined;
  if (crop) {
    crop.width = Math.min(crop.width, sourceWidth - crop.left);
    crop.height = Math.min(crop.height, sourceHeight - crop.top);
  }
  const pipeline = sharp(oriented);
  if (crop) pipeline.extract(crop);
  return pipeline
    .resize(width, height, { fit: "cover", position: "attention" })
    .composite(layers)
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

export async function createGeekDanceWechatFallbackCover(
  title: string,
  _brandLockup?: Uint8Array,
) {
  const compactTitle = Array.from(title.trim()).slice(0, 22).join("");
  const background = await renderGeneratedImageSvg(
    `<svg width="900" height="900" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111216"/><stop offset="1" stop-color="#292A30"/></linearGradient><radialGradient id="accent" cx="84%" cy="74%" r="70%"><stop stop-color="#DA251C" stop-opacity=".72"/><stop offset="1" stop-color="#DA251C" stop-opacity="0"/></radialGradient></defs>
      <rect width="900" height="900" fill="url(#base)"/><rect width="900" height="900" fill="url(#accent)"/>
      <path d="M590 760 850 520M680 820 886 630" stroke="#FFFFFF" stroke-opacity=".10" stroke-width="44"/>
      <rect x="54" y="510" width="9" height="104" rx="4.5" fill="#DA251C"/>
      <text x="88" y="554" fill="#FFFFFF" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="35" font-weight="700">${escapeXml(compactTitle)}</text>
      <text x="88" y="600" fill="#FFFFFF" fill-opacity=".68" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="16" font-weight="400" letter-spacing="3">极客跳动编辑部</text>
    </svg>`,
  );
  return applyGeekDanceWechatCoverStyle(
    new Uint8Array(background),
    _brandLockup,
  );
}

/**
 * Produces one stacked master image. WeChat derives a branded 2.35:1 first
 * cover from its top and a square second cover from its lower region.
 */
export async function applyGeekDanceWechatCoverStyle(
  wideBuffer: Uint8Array,
  brandLockup?: Uint8Array,
  squareBuffer: Uint8Array = wideBuffer,
  cropRegions?: WechatCoverRegions,
) {
  const wide = await brandedCrop(
    wideBuffer,
    WECHAT_COVER_WIDTH,
    WECHAT_COVER_WIDE_HEIGHT,
    brandLockup,
    cropRegions?.wide,
  );
  const square = await brandedCrop(
    squareBuffer,
    WECHAT_COVER_WIDTH,
    900,
    brandLockup,
    cropRegions?.square,
  );
  const master = await sharp({
    create: {
      width: WECHAT_COVER_WIDTH,
      height: WECHAT_COVER_HEIGHT,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: wide, left: 0, top: 0 },
      { input: square, left: 0, top: WECHAT_COVER_WIDE_HEIGHT },
    ])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return {
    buffer: new Uint8Array(master),
    mime: "image/jpeg",
    crops: WECHAT_COVER_CROPS,
  };
}

export async function applyGeekDanceWebsiteCoverStyle(buffer: Uint8Array) {
  const metadata = await sharp(buffer).metadata();
  const width = Math.max(640, Math.min(2400, metadata.width ?? 1600));
  const base = await sharp(buffer).rotate().resize({ width }).toBuffer();
  const info = await sharp(base).metadata();
  const branded = await sharp(base)
    .composite([
      {
        input: websiteBrandOverlay(
          info.width ?? width,
          Math.min(info.height ?? 900, 480),
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { buffer: new Uint8Array(branded), mime: "image/jpeg" };
}
