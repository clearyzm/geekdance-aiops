"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Move, X } from "lucide-react";
import { Button, inputClass } from "@/components/ui";

export type CropRatio = "1:1" | "3:4" | "4:3" | "16:9" | "2.35:1";
export type CropRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ratioValue: Record<CropRatio, number> = {
  "1:1": 1,
  "3:4": 3 / 4,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
  "2.35:1": 2.35,
};

const ratioLabels: Record<CropRatio, string> = {
  "1:1": "1:1 方图",
  "3:4": "3:4 竖图",
  "4:3": "4:3 正文",
  "16:9": "16:9 横图",
  "2.35:1": "2.35:1 公众号首图",
};

function initialRegion(ratio: CropRatio, imageAspect: number): CropRegion {
  const normalizedRatio = ratioValue[ratio] / imageAspect;
  let width = 0.82;
  let height = width / normalizedRatio;
  if (height > 0.82) {
    height = 0.82;
    width = height * normalizedRatio;
  }
  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  };
}

type DragMode =
  "move" | "top_left" | "top_right" | "bottom_left" | "bottom_right";

export function ManualReviewCropDialog({
  imageUrl,
  initialRatio,
  busy,
  allowedRatios,
  onClose,
  onConfirm,
}: {
  imageUrl: string;
  initialRatio: CropRatio;
  busy: boolean;
  allowedRatios?: CropRatio[];
  onClose: () => void;
  onConfirm: (region: CropRegion, ratio: CropRatio) => void;
}) {
  const imageBoxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    region: CropRegion;
  } | null>(null);
  const [ratio, setRatio] = useState<CropRatio>(initialRatio);
  const [imageAspect, setImageAspect] = useState(4 / 3);
  const [region, setRegion] = useState<CropRegion>(() =>
    initialRegion(initialRatio, 4 / 3),
  );
  const availableRatios = allowedRatios?.length
    ? allowedRatios
    : (["16:9", "4:3", "3:4", "1:1"] as CropRatio[]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const bounds = imageBoxRef.current?.getBoundingClientRect();
      if (!drag || !bounds?.width || !bounds.height) return;
      const dx = (event.clientX - drag.startX) / bounds.width;
      const dy = (event.clientY - drag.startY) / bounds.height;
      const start = drag.region;
      if (drag.mode === "move") {
        setRegion({
          ...start,
          x: Math.max(0, Math.min(1 - start.width, start.x + dx)),
          y: Math.max(0, Math.min(1 - start.height, start.y + dy)),
        });
        return;
      }

      const normalizedRatio = ratioValue[ratio] / imageAspect;
      const minWidth = Math.max(0.12, 0.12 * normalizedRatio);
      const right = start.x + start.width;
      const bottom = start.y + start.height;
      const widthFromHorizontal = drag.mode.endsWith("right")
        ? start.width + dx
        : start.width - dx;
      const heightFromVertical = drag.mode.startsWith("top")
        ? start.height - dy
        : start.height + dy;
      let width =
        Math.abs(dx) >= Math.abs(dy * normalizedRatio)
          ? widthFromHorizontal
          : heightFromVertical * normalizedRatio;

      const maxWidth =
        drag.mode === "top_left"
          ? Math.min(right, bottom * normalizedRatio)
          : drag.mode === "top_right"
            ? Math.min(1 - start.x, bottom * normalizedRatio)
            : drag.mode === "bottom_left"
              ? Math.min(right, (1 - start.y) * normalizedRatio)
              : Math.min(1 - start.x, (1 - start.y) * normalizedRatio);
      width = Math.max(Math.min(minWidth, maxWidth), Math.min(maxWidth, width));
      const height = width / normalizedRatio;
      setRegion({
        x: drag.mode.endsWith("left") ? right - width : start.x,
        y: drag.mode.startsWith("top") ? bottom - height : start.y,
        width,
        height,
      });
    };
    const onPointerUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [imageAspect, ratio]);

  const startDrag = (mode: DragMode, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      region,
    };
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="手动裁剪图片"
      className="fixed inset-0 z-[80] grid place-items-center bg-[#101014]/75 p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-[0_30px_90px_rgba(0,0,0,.35)]">
        <div className="flex items-center justify-between border-b border-[#ededf0] px-5 py-4">
          <div>
            <h2 className="font-bold text-[#17171a]">手动调整裁剪范围</h2>
            <p className="mt-1 text-xs text-[#73737c]">
              拖动选框调整位置，拖动四角改变范围；阴影区域不会保留。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭裁剪"
            disabled={busy}
            onClick={onClose}
            className="focus-ring rounded-xl p-2 text-[#666a73] hover:bg-[#f3f3f5] disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-[#222329] p-4 sm:p-6">
          <div
            ref={imageBoxRef}
            className="relative mx-auto w-fit max-w-full select-none overflow-hidden rounded-lg"
          >
            <img
              src={imageUrl}
              alt="待裁剪图片"
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget;
                const nextAspect = image.naturalWidth / image.naturalHeight;
                setImageAspect(nextAspect);
                setRegion(initialRegion(ratio, nextAspect));
              }}
              className="block max-h-[64dvh] max-w-full object-contain"
            />
            <div
              onPointerDown={(event) => startDrag("move", event)}
              className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,.58)]"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            >
              <span className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-55">
                {Array.from({ length: 9 }).map((_, index) => (
                  <span
                    key={index}
                    className={`border-white/60 ${index % 3 !== 2 ? "border-r" : ""} ${index < 6 ? "border-b" : ""}`}
                  />
                ))}
              </span>
              <span className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white">
                <Move size={12} />
                拖动
              </span>
              {(
                [
                  ["top_left", "-left-2 -top-2 cursor-nwse-resize"],
                  ["top_right", "-right-2 -top-2 cursor-nesw-resize"],
                  ["bottom_left", "-bottom-2 -left-2 cursor-nesw-resize"],
                  ["bottom_right", "-bottom-2 -right-2 cursor-nwse-resize"],
                ] as const
              ).map(([mode, position]) => (
                <button
                  key={mode}
                  type="button"
                  aria-label={`调整裁剪框 ${mode}`}
                  onPointerDown={(event) => startDrag(mode, event)}
                  className={`absolute h-5 w-5 rounded-md border-2 border-[#e60012] bg-white shadow-md ${position}`}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#ededf0] bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-3 text-xs font-semibold text-[#55555d]">
            输出比例
            <select
              value={ratio}
              className={`${inputClass} h-10 w-40 py-0`}
              onChange={(event) => {
                const nextRatio = event.target.value as CropRatio;
                setRatio(nextRatio);
                setRegion(initialRegion(nextRatio, imageAspect));
              }}
            >
              {availableRatios.map((item) => (
                <option key={item} value={item}>
                  {ratioLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => onConfirm(region, ratio)}
              disabled={busy}
            >
              <Check size={15} />
              {busy ? "正在生成…" : "应用裁剪"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
