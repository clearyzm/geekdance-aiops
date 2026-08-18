from __future__ import annotations

import hashlib
import io
import os
from functools import lru_cache
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps, ImageStat

app = FastAPI(title="GeekDance Image Worker", docs_url=None, redoc_url=None)

SIZES = {
    "1:1": (1200, 1200),
    "3:4": (1200, 1600),
    "4:5": (1200, 1500),
    "4:3": (1600, 1200),
    "16:9": (1600, 900),
    "wechat_cover": (900, 383),
}
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000


def size_for(ratio: str) -> tuple[int, int]:
    if ratio not in SIZES:
        raise HTTPException(400, "unsupported ratio")
    return SIZES[ratio]


async def load_image(file: UploadFile) -> Image.Image:
    data = await file.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, "image too large")
    try:
        image = Image.open(io.BytesIO(data))
        image.verify()
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > MAX_PIXELS:
            raise HTTPException(413, "image dimensions too large")
        return ImageOps.exif_transpose(image).convert("RGBA")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(400, "invalid image") from error


def png_response(image: Image.Image) -> Response:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return Response(output.getvalue(), media_type="image/png")


def image_response(image: Image.Image, output_format: str = "png") -> Response:
    if output_format == "png":
        return png_response(image)
    if output_format != "jpeg":
        raise HTTPException(400, "unsupported output format")
    flattened = Image.new("RGB", image.size, (250, 249, 247))
    if image.mode == "RGBA":
        flattened.paste(image, mask=image.getchannel("A"))
    else:
        flattened.paste(image.convert("RGB"))
    output = io.BytesIO()
    flattened.save(
        output,
        format="JPEG",
        quality=90,
        optimize=True,
        progressive=True,
        subsampling="4:2:0",
    )
    return Response(output.getvalue(), media_type="image/jpeg")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "image-worker",
        "release": os.environ.get("APP_RELEASE", "local"),
    }


@app.post("/placeholder")
def placeholder(prompt: Annotated[str, Form(max_length=2000)], ratio: Annotated[str, Form()] = "16:9") -> Response:
    width, height = size_for(ratio)
    digest = hashlib.sha256(prompt.encode("utf-8")).digest()
    image = Image.new("RGB", (width, height), "#F7F5F2")
    draw = ImageDraw.Draw(image, "RGBA")
    for index in range(12):
        x = int((digest[index] / 255) * width)
        y = int((digest[index + 8] / 255) * height)
        radius = int(min(width, height) * (0.04 + digest[index + 16] / 255 * 0.12))
        color = (218, 37, 28, 32 + index * 5) if index % 3 == 0 else (24, 24, 28, 18 + index * 3)
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
    draw.rounded_rectangle((int(width * .58), int(height * .17), int(width * .87), int(height * .83)), radius=int(min(width, height) * .035), fill=(28, 28, 31, 235))
    draw.rounded_rectangle((int(width * .62), int(height * .23), int(width * .83), int(height * .77)), radius=int(min(width, height) * .025), fill=(245, 243, 239, 255))
    draw.rectangle((int(width * .62), int(height * .60), int(width * .83), int(height * .64)), fill=(218, 37, 28, 220))
    return png_response(image.filter(ImageFilter.GaussianBlur(radius=0.15)).convert("RGBA"))


@app.post("/resize")
async def resize(
    file: Annotated[UploadFile, File()],
    ratio: Annotated[str, Form()] = "16:9",
    output_format: Annotated[str, Form()] = "png",
) -> Response:
    image = await load_image(file)
    result = ImageOps.fit(image, size_for(ratio), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    return image_response(result, output_format)


@app.post("/crop")
async def crop(
    file: Annotated[UploadFile, File()],
    x: Annotated[float, Form(ge=0, le=1)],
    y: Annotated[float, Form(ge=0, le=1)],
    width: Annotated[float, Form(gt=0, le=1)],
    height: Annotated[float, Form(gt=0, le=1)],
    ratio: Annotated[str, Form()] = "16:9",
) -> Response:
    image = await load_image(file)
    if x + width > 1.000001 or y + height > 1.000001:
        raise HTTPException(400, "crop region outside image")
    left = max(0, min(image.width - 1, round(x * image.width)))
    top = max(0, min(image.height - 1, round(y * image.height)))
    right = max(left + 1, min(image.width, round((x + width) * image.width)))
    bottom = max(top + 1, min(image.height, round((y + height) * image.height)))
    result = image.crop((left, top, right, bottom)).resize(
        size_for(ratio), Image.Resampling.LANCZOS
    )
    return png_response(result)


@app.post("/compose")
async def compose(
    foreground: Annotated[UploadFile, File()],
    background: Annotated[UploadFile, File()],
    ratio: Annotated[str, Form()] = "16:9",
    position: Annotated[str, Form()] = "auto",
    scale: Annotated[float, Form(ge=0, le=0.9)] = 0,
    output_format: Annotated[str, Form()] = "png",
) -> Response:
    if position not in {"auto", "left", "center", "right"}:
        raise HTTPException(400, "unsupported foreground position")
    subject = await load_image(foreground)
    scene = await load_image(background)
    alpha = subject.getchannel("A")
    if alpha.getextrema()[0] >= 250:
        raise HTTPException(400, "foreground must have a transparent background")
    bounds = alpha.getbbox()
    if not bounds:
        raise HTTPException(400, "foreground is fully transparent")
    subject = subject.crop(bounds)
    width, height = size_for(ratio)
    canvas = ImageOps.fit(
        scene,
        (width, height),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    if scale <= 0:
        subject_ratio = subject.width / max(1, subject.height)
        scale = max(.5, min(.78, .7 - max(0, subject_ratio - .7) * .12))
    target_height = max(1, int(height * scale))
    target_width = max(1, int(subject.width * target_height / subject.height))
    max_width = int(width * 0.9)
    if target_width > max_width:
        target_width = max_width
        target_height = max(1, int(subject.height * target_width / subject.width))
    subject = subject.resize(
        (target_width, target_height),
        Image.Resampling.LANCZOS,
    )
    margin_x = max(16, int(width * 0.035))
    margin_y = max(12, int(height * 0.025))
    positions = {
        "left": margin_x,
        "center": (width - subject.width) // 2,
        "right": width - subject.width - margin_x,
    }
    if position == "auto":
        gray = canvas.convert("L")
        left_variance = ImageStat.Stat(gray.crop((0, 0, width // 2, height))).var[0]
        right_variance = ImageStat.Stat(gray.crop((width // 2, 0, width, height))).var[0]
        position = "left" if left_variance <= right_variance else "right"
    x = max(0, min(positions[position], width - subject.width))
    y = max(0, height - subject.height - margin_y)
    shadow_alpha = subject.getchannel("A").filter(
        ImageFilter.GaussianBlur(radius=max(3, int(min(width, height) * 0.012)))
    )
    shadow = Image.new("RGBA", subject.size, (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha.point(lambda value: int(value * 0.22)))
    shadow_offset = max(3, int(min(width, height) * 0.008))
    canvas.alpha_composite(
        shadow,
        (min(width - shadow.width, x + shadow_offset), min(height - shadow.height, y + shadow_offset)),
    )
    canvas.alpha_composite(subject, (x, y))
    return image_response(canvas, output_format)


@app.post("/overlay")
async def overlay(
    file: Annotated[UploadFile, File()],
    logo: Annotated[UploadFile, File()],
    position: Annotated[str, Form()] = "bottom_right",
    x: Annotated[float, Form(ge=-1, le=1)] = -1,
    y: Annotated[float, Form(ge=-1, le=1)] = -1,
    width_ratio: Annotated[float, Form(ge=.03, le=.6)] = .22,
    output_format: Annotated[str, Form()] = "png",
) -> Response:
    image = await load_image(file)
    mark = await load_image(logo)
    target_width = max(24, int(image.width * width_ratio))
    mark.thumbnail((target_width, max(24, int(image.height * .6))), Image.Resampling.LANCZOS)
    mark = ImageEnhance.Contrast(mark).enhance(1.02)
    margin = max(18, int(min(image.size) * .03))
    positions = {
        "top_left": (margin, margin),
        "top_right": (image.width - mark.width - margin, margin),
        "bottom_left": (margin, image.height - mark.height - margin),
        "bottom_right": (image.width - mark.width - margin, image.height - mark.height - margin),
    }
    if x >= 0 and y >= 0:
        placement = (
            max(0, min(image.width - mark.width, round(x * image.width))),
            max(0, min(image.height - mark.height, round(y * image.height))),
        )
    else:
        if position not in positions:
            raise HTTPException(400, "unsupported logo position")
        placement = positions[position]
    image.alpha_composite(mark, placement)
    return image_response(image, output_format)


@lru_cache(maxsize=1)
def rembg_session():
    from rembg import new_session

    return new_session("u2net")


@app.post("/remove-background")
async def remove_background(file: Annotated[UploadFile, File()]) -> Response:
    image = await load_image(file)
    try:
        from rembg import remove

        session = rembg_session()
    except Exception as error:
        raise HTTPException(503, f"background model unavailable: {type(error).__name__}") from error
    try:
        result = remove(image, session=session, alpha_matting=True, alpha_matting_foreground_threshold=240, alpha_matting_background_threshold=10)
    except Exception:
        try:
            result = remove(image, session=session, alpha_matting=False)
        except Exception as error:
            raise HTTPException(503, f"background removal failed: {type(error).__name__}") from error
    return png_response(result.convert("RGBA"))
