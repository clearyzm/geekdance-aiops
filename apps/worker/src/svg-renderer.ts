import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

export const GENERATED_IMAGE_FONT_FAMILY = "Alibaba PuHuiTi 2.0";
export const GENERATED_IMAGE_LETTER_SPACING = "0.03em";

const regularFontPath =
  process.env.ALIBABA_PUHUITI_REGULAR_PATH ??
  "/usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-55-Regular.ttf";
const boldFontPath =
  process.env.ALIBABA_PUHUITI_BOLD_PATH ??
  "/usr/local/share/fonts/alibaba-puhuiti/AlibabaPuHuiTi-2-85-Bold.ttf";

export function applyGeneratedImageTypography(svg: string) {
  return svg.replace(/<text\b([^>]*)>/gu, (element, attributes: string) =>
    /\bletter-spacing\s*=/u.test(attributes)
      ? element
      : `<text${attributes} letter-spacing="${GENERATED_IMAGE_LETTER_SPACING}">`,
  );
}

function availableFontFiles() {
  return [regularFontPath, boldFontPath].filter((path) => existsSync(path));
}

export async function renderGeneratedImageSvg(
  input: string | Uint8Array | Buffer,
) {
  const svg = applyGeneratedImageTypography(
    typeof input === "string" ? input : Buffer.from(input).toString("utf8"),
  );
  const fontFiles = availableFontFiles();
  if (fontFiles.length !== 2) {
    if (process.env.NODE_ENV === "production")
      throw new Error("ALIBABA_PUHUITI_TTF_MISSING");
    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  }
  return Buffer.from(
    new Resvg(svg, {
      font: {
        fontFiles,
        loadSystemFonts: false,
        defaultFontFamily: GENERATED_IMAGE_FONT_FAMILY,
      },
    })
      .render()
      .asPng(),
  );
}

export async function verifyGeneratedImageFonts() {
  const fontFiles = availableFontFiles();
  if (fontFiles.length !== 2) {
    if (process.env.NODE_ENV === "production")
      throw new Error("ALIBABA_PUHUITI_TTF_MISSING");
    return { verified: false, reason: "font_files_missing" as const };
  }
  const svg = applyGeneratedImageTypography(
    `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="160"><rect width="760" height="160" fill="#FFFFFF"/><text x="24" y="106" font-family="${GENERATED_IMAGE_FONT_FAMILY}" font-size="54" font-weight="400">阿里巴巴普惠体 GeekDance</text></svg>`,
  );
  const render = (files: string[]) =>
    Buffer.from(
      new Resvg(svg, {
        font: {
          fontFiles: files,
          loadSystemFonts: false,
          defaultFontFamily: GENERATED_IMAGE_FONT_FAMILY,
        },
      })
        .render()
        .asPng(),
    );
  const branded = render(fontFiles);
  const withoutFonts = render([]);
  const digest = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  if (branded.length < 2_000 || digest(branded) === digest(withoutFonts))
    throw new Error("ALIBABA_PUHUITI_RENDER_VERIFICATION_FAILED");
  return { verified: true, regularFontPath, boldFontPath };
}
