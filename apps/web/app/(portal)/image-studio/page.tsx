"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Combine,
  ClipboardPaste,
  Crop,
  Eraser,
  ImagePlus,
  LoaderCircle,
  MousePointer2,
  PencilLine,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { csrfToken } from "@/lib/content";

type Operation =
  | "generate"
  | "remove_background"
  | "compose"
  | "resize"
  | "logo_overlay"
  | "xiaohongshu_cover_text";
type Asset = {
  id: string;
  source: string;
  status: string;
  fileUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};
type ImageJob = {
  id: string;
  status: string;
  progress: { percent: number; message: string };
  errorCode?: string;
  outputs: Asset[];
  model?: string;
  costCents?: number;
};
type NormalizedRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type CoverTextBlock = NormalizedRegion & { text: string };
type LogoPlacement = { x: number; y: number; width: number };

const operations: Array<{
  id: Operation;
  icon: typeof Sparkles;
  title: string;
  desc: string;
}> = [
  {
    id: "remove_background",
    icon: Eraser,
    title: "透明抠图",
    desc: "rembg 本地分割，输出透明 PNG",
  },
  {
    id: "compose",
    icon: Combine,
    title: "人物与背景融合",
    desc: "选择透明人物和背景，AI 重建光影、边缘与空间关系",
  },
  {
    id: "generate",
    icon: Sparkles,
    title: "AI 生图",
    desc: "根据提示词生成全新的品牌视觉",
  },
  {
    id: "resize",
    icon: Crop,
    title: "尺寸适配",
    desc: "确定性中心裁切到渠道比例",
  },
  {
    id: "logo_overlay",
    icon: ShieldCheck,
    title: "官方 Logo 叠加",
    desc: "上传底图和 Logo，在预览中拖动到目标位置",
  },
  {
    id: "xiaohongshu_cover_text",
    icon: PencilLine,
    title: "小红书封面改字",
    desc: "AI 识别原文字块，选中后只替换目标区域",
  },
];

export default function ImageStudioPage() {
  const [operation, setOperation] = useState<Operation>("remove_background");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<ImageJob | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState<"library" | number | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [textBlocks, setTextBlocks] = useState<CoverTextBlock[]>([]);
  const [selectedTextIndex, setSelectedTextIndex] = useState<number | null>(
    null,
  );
  const [textRegion, setTextRegion] = useState<NormalizedRegion | null>(null);
  const [logoPlacement, setLogoPlacement] = useState<LogoPlacement>({
    x: 0.74,
    y: 0.82,
    width: 0.22,
  });
  const [logoDragOffset, setLogoDragOffset] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const logoPreviewRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const selectedOperation = useMemo(
    () => operations.find((item) => item.id === operation)!,
    [operation],
  );
  const usableAssets = useMemo(
    () => assets.filter((asset) => asset.status !== "missing" && asset.fileUrl),
    [assets],
  );
  const sourceRule =
    operation === "generate"
      ? "无需选择素材"
      : operation === "compose"
        ? "按顺序选择：①透明人物 ②背景图"
        : operation === "logo_overlay"
          ? "按顺序选择：①底图 ②透明 Logo"
          : "请选择 1 张素材";
  const selectionReady =
    operation === "generate" ||
    (["compose", "logo_overlay"].includes(operation)
      ? selected.filter(Boolean).length === 2
      : selected.length === 1);

  const loadAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const response = await fetch("/api/assets", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("内容资产读取失败");
      setAssets(((await response.json()) as { assets: Asset[] }).assets);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "内容资产读取失败");
    } finally {
      setAssetsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  function chooseOperation(next: Operation) {
    setOperation(next);
    setSelected([]);
    setJob(null);
    setError("");
    setTextBlocks([]);
    setSelectedTextIndex(null);
    setTextRegion(null);
  }

  function toggleAsset(id: string) {
    if (operation === "generate") return;
    if (operation === "xiaohongshu_cover_text") {
      setTextBlocks([]);
      setSelectedTextIndex(null);
      setTextRegion(null);
    }
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : ["compose", "logo_overlay"].includes(operation)
          ? [...current, id].slice(-2)
          : [id],
    );
  }

  async function uploadFile(file: File, selectionIndex?: number) {
    setUploadBusy(selectionIndex ?? "library");
    setError("");
    setNotice("");
    try {
      if (!file.size) throw new Error("请选择需要上传的图片");
      if (file.size > 20 * 1024 * 1024)
        throw new Error(`图片“${file.name}”超过 20 MiB`);
      const form = new FormData();
      form.append("file", file);
      const token = await csrfToken();
      const response = await fetch("/api/assets/upload", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": token },
        body: form,
      });
      const data = (await response.json()) as {
        asset?: Asset;
        error?: string;
        message?: string;
      };
      if (!response.ok || !data.asset)
        throw new Error(
          data.message ??
            {
              IMAGE_TOO_LARGE: "图片超过 20 MiB",
              INVALID_IMAGE_FILE: "仅支持内容有效的 PNG、JPG 或 WebP 图片",
              IMAGE_FILE_REQUIRED: "请选择需要上传的图片",
            }[data.error ?? ""] ??
            "素材上传失败",
        );
      setNotice("素材已上传并进入内容资产");
      await loadAssets();
      if (selectionIndex !== undefined)
        setSelected((current) => {
          const next = [...current];
          next[selectionIndex] = data.asset!.id;
          return next;
        });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材上传失败");
    } finally {
      setUploadBusy(null);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const file = new FormData(formElement).get("file");
    if (!(file instanceof File) || !file.size) {
      setError("请选择需要上传的图片");
      return;
    }
    await uploadFile(file);
    formElement.reset();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setJobBusy(true);
    setError("");
    setNotice("");
    setJob(null);
    try {
      const token = await csrfToken();
      const response = await fetch("/api/image-jobs", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          operation,
          sourceAssetIds: selected.filter(Boolean),
          prompt: String(form.get("prompt") ?? "").trim() || undefined,
          ratio: form.get("ratio"),
          count: Number(form.get("count") ?? 1),
          quality: form.get("quality"),
          logoPlacement:
            operation === "logo_overlay" ? logoPlacement : undefined,
          textRegion:
            operation === "xiaohongshu_cover_text" ? textRegion : undefined,
          detectedText:
            operation === "xiaohongshu_cover_text" && selectedTextIndex !== null
              ? textBlocks[selectedTextIndex]?.text
              : undefined,
          rightsConfirmed: true,
        }),
      });
      const data = (await response.json()) as {
        job?: ImageJob;
        message?: string;
        error?: string;
      };
      if (!response.ok || !data.job)
        throw new Error(data.message ?? data.error ?? "图片任务提交失败");
      setJob(data.job);
      const deadline = Date.now() + 240_000;
      let reachedTerminalState = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const current = await fetch(`/api/image-jobs/${data.job.id}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!current.ok) throw new Error("无法读取图片任务进度");
        const next = (await current.json()) as {
          job: ImageJob;
          terminal: boolean;
        };
        setJob(next.job);
        if (next.terminal) {
          reachedTerminalState = true;
          await loadAssets();
          break;
        }
      }
      if (!reachedTerminalState)
        setNotice(
          `图片任务仍在后台执行，任务 ID：${data.job.id}。稍后可在素材库查看结果。`,
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片任务失败");
    } finally {
      setJobBusy(false);
    }
  }

  async function recognizeCoverText() {
    const assetId = selected[0];
    if (!assetId) return;
    setOcrBusy(true);
    setError("");
    setNotice("");
    setTextBlocks([]);
    setSelectedTextIndex(null);
    setTextRegion(null);
    try {
      const response = await fetch(
        `/api/assets/${assetId}/recognize-cover-text`,
        {
          method: "POST",
          credentials: "include",
          headers: { "x-csrf-token": await csrfToken() },
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        blocks?: CoverTextBlock[];
        message?: string;
        error?: string;
      };
      if (!response.ok || !data.blocks)
        throw new Error(data.message ?? data.error ?? "封面文字识别失败");
      setTextBlocks(data.blocks);
      if (data.blocks[0]) {
        setSelectedTextIndex(0);
        setTextRegion(data.blocks[0]);
      }
      setNotice(
        data.blocks.length
          ? `已识别 ${data.blocks.length} 个文字块，请点击图中需要修改的位置`
          : "未识别到清晰文字，请更换更清晰的封面",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "封面文字识别失败");
    } finally {
      setOcrBusy(false);
    }
  }

  function moveLogo(clientX: number, clientY: number) {
    const preview = logoPreviewRef.current;
    if (!preview || !logoDragOffset) return;
    const bounds = preview.getBoundingClientRect();
    setLogoPlacement((current) => ({
      ...current,
      x: Math.max(
        0,
        Math.min(
          1 - current.width,
          (clientX - bounds.left - logoDragOffset.x) / bounds.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          0.85,
          (clientY - bounds.top - logoDragOffset.y) / bounds.height,
        ),
      ),
    }));
  }

  return (
    <>
      <PageHeader
        eyebrow="Image Workshop"
        title="图片工坊"
        description="AI 生图、透明抠图、人物背景自动融合、尺寸适配、局部改字与自定义 Logo 叠加；结果自动归档内容资产。"
      />
      {(notice || error) && (
        <div
          role={error ? "alert" : "status"}
          className={`mb-5 rounded-2xl border px-4 py-3 text-sm ${error ? "border-[#f6b8be] bg-[#fff1f2] text-[#b90012]" : "border-[#bde3cb] bg-[#edf8f1] text-[#187844]"}`}
        >
          {error || notice}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[.72fr_1.5fr]">
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="font-bold">选择工具</h2>
            <div className="mt-4 grid gap-2">
              {operations.map(({ id, icon: Icon, title, desc }) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => chooseOperation(id)}
                  className={`flex items-center gap-3 rounded-2xl border p-3 text-left transition ${operation === id ? "border-[#f6b8be] bg-[#fff7f8]" : "border-[#ededf0] hover:border-[#d6d6dc]"}`}
                >
                  <span
                    className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${operation === id ? "bg-[#e60012] text-white" : "bg-[#f2f2f4] text-[#55555d]"}`}
                  >
                    <Icon size={18} />
                  </span>
                  <span>
                    <strong className="block text-sm">{title}</strong>
                    <small className="mt-0.5 block leading-4 text-[#85858e]">
                      {desc}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <Upload size={17} className="text-[#e60012]" />
              <h2 className="font-bold">上传源素材</h2>
            </div>
            <form
              onSubmit={upload}
              onPaste={(event) => {
                const file = Array.from(event.clipboardData.files).find(
                  (item) => item.type.startsWith("image/"),
                );
                if (file) {
                  event.preventDefault();
                  void uploadFile(file);
                }
              }}
              className="mt-4 grid gap-3"
            >
              <label className="focus-ring flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-[#d8d8dd] bg-[#fafafa] px-3 py-3 text-xs font-semibold text-[#55555d]">
                <Upload size={15} className="text-[#e60012]" />
                选择图片，或直接粘贴截图
                <ClipboardPaste size={14} className="ml-auto text-[#85858e]" />
                <input
                  required
                  type="file"
                  name="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                />
              </label>
              <Button
                type="submit"
                variant="secondary"
                disabled={uploadBusy !== null}
                className={uploadBusy === "library" ? "cursor-wait" : ""}
              >
                {uploadBusy === "library" ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <Upload size={15} />
                )}
                {uploadBusy === "library"
                  ? "正在上传并加入内容资产…"
                  : "添加到内容资产"}
              </Button>
            </form>
            <p className="mt-3 text-xs leading-5 text-[#85858e]">
              支持 PNG、JPG、WebP，单文件不超过 20 MiB。
            </p>
          </Card>
        </div>
        <div className="space-y-5">
          <Card className="p-6 sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Badge tone="red">{selectedOperation.title}</Badge>
                <h2 className="mt-3 text-xl font-bold">创建图片任务</h2>
              </div>
              <span className="text-xs text-[#85858e]">{sourceRule}</span>
            </div>
            {["compose", "logo_overlay"].includes(operation) && (
              <div className="mt-6 grid gap-3 md:grid-cols-2">
                {(operation === "compose"
                  ? [
                      ["人物图片", "建议使用透明背景 PNG", 0],
                      ["背景图片", "建议使用清晰完整的场景图", 1],
                    ]
                  : [
                      ["底图", "Logo 将叠加到这张图上", 0],
                      ["Logo 图片", "建议使用透明背景 PNG", 1],
                    ]
                ).map(([label, hint, rawIndex]) => {
                  const index = Number(rawIndex);
                  return (
                    <div
                      key={String(label)}
                      tabIndex={0}
                      onPaste={(event) => {
                        const file = Array.from(event.clipboardData.files).find(
                          (item) => item.type.startsWith("image/"),
                        );
                        if (file) {
                          event.preventDefault();
                          void uploadFile(file, index);
                        }
                      }}
                      className="rounded-2xl border border-[#ededf0] p-4"
                    >
                      <strong className="text-sm">{label}</strong>
                      <p className="mt-1 text-[11px] text-[#85858e]">{hint}</p>
                      <select
                        className={`${inputClass} mt-3`}
                        value={selected[index] ?? ""}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = [...current];
                            next[index] = event.target.value;
                            return next;
                          })
                        }
                      >
                        <option value="">从内容资产选择</option>
                        {usableAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {String(
                              asset.metadata.displayName ??
                                asset.metadata.originalName ??
                                asset.metadata.operation ??
                                asset.source,
                            )}
                          </option>
                        ))}
                      </select>
                      <label
                        className={`mt-2 flex items-center justify-center gap-2 rounded-xl border border-dashed border-[#dedee3] px-3 py-2 text-xs font-semibold ${uploadBusy === index ? "cursor-wait opacity-70" : "cursor-pointer"}`}
                      >
                        {uploadBusy === index ? (
                          <LoaderCircle size={14} className="animate-spin" />
                        ) : (
                          <Upload size={14} />
                        )}
                        {uploadBusy === index
                          ? `正在上传${label}…`
                          : `上传或粘贴${label}`}
                        <input
                          type="file"
                          disabled={uploadBusy !== null}
                          accept="image/png,image/jpeg,image/webp"
                          className="sr-only"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void uploadFile(file, index);
                            event.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
            {operation === "logo_overlay" && selected[0] && selected[1] && (
              <div className="mt-5 rounded-2xl border border-[#ededf0] bg-[#f6f6f7] p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[#55555d]">
                  <MousePointer2 size={15} className="text-[#e60012]" />
                  拖动 Logo 到目标位置，下方可调整大小
                </div>
                <div
                  ref={logoPreviewRef}
                  onPointerMove={(event) =>
                    moveLogo(event.clientX, event.clientY)
                  }
                  onPointerUp={() => setLogoDragOffset(null)}
                  onPointerCancel={() => setLogoDragOffset(null)}
                  className="relative mx-auto w-fit max-w-full touch-none overflow-hidden rounded-xl bg-[#dedee3]"
                >
                  <img
                    src={
                      usableAssets.find((asset) => asset.id === selected[0])
                        ?.fileUrl ?? ""
                    }
                    alt="Logo 叠加底图预览"
                    className="block max-h-[620px] max-w-full object-contain"
                    draggable={false}
                  />
                  <img
                    src={
                      usableAssets.find((asset) => asset.id === selected[1])
                        ?.fileUrl ?? ""
                    }
                    alt="可拖动 Logo"
                    draggable={false}
                    onPointerDown={(event) => {
                      const logoBounds =
                        event.currentTarget.getBoundingClientRect();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setLogoDragOffset({
                        x: event.clientX - logoBounds.left,
                        y: event.clientY - logoBounds.top,
                      });
                    }}
                    className="absolute cursor-grab touch-none object-contain active:cursor-grabbing"
                    style={{
                      left: `${logoPlacement.x * 100}%`,
                      top: `${logoPlacement.y * 100}%`,
                      width: `${logoPlacement.width * 100}%`,
                    }}
                  />
                </div>
                <label className="mt-4 block text-xs text-[#666a73]">
                  Logo 宽度：{Math.round(logoPlacement.width * 100)}%
                  <input
                    type="range"
                    min="5"
                    max="50"
                    step="1"
                    value={Math.round(logoPlacement.width * 100)}
                    onChange={(event) => {
                      const width = Number(event.target.value) / 100;
                      setLogoPlacement((current) => ({
                        ...current,
                        width,
                        x: Math.min(current.x, 1 - width),
                      }));
                    }}
                    className="mt-2 block w-full accent-[#e60012]"
                  />
                </label>
              </div>
            )}
            {operation !== "generate" &&
              operation !== "compose" &&
              operation !== "logo_overlay" && (
                <div className="mt-6">
                  <p className="mb-3 text-sm font-semibold">素材库</p>
                  {assetsLoading ? (
                    <div className="grid min-h-32 place-items-center rounded-xl bg-[#f7f7f8] text-xs text-[#85858e]">
                      <span className="inline-flex items-center gap-2">
                        <LoaderCircle size={15} className="animate-spin" />
                        正在读取内容资产…
                      </span>
                    </div>
                  ) : usableAssets.length ? (
                    <div className="grid max-h-[360px] grid-cols-2 gap-3 overflow-y-auto pr-1 md:grid-cols-3">
                      {usableAssets.map((asset) => (
                        <button
                          type="button"
                          key={asset.id}
                          onClick={() => toggleAsset(asset.id)}
                          className={`relative overflow-hidden rounded-xl border-2 bg-[#f5f5f6] ${selected.includes(asset.id) ? "border-[#e60012]" : "border-transparent"}`}
                        >
                          {selected.includes(asset.id) && (
                            <span className="absolute left-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-full bg-[#e60012] text-xs font-bold text-white shadow">
                              {selected.indexOf(asset.id) + 1}
                            </span>
                          )}
                          <img
                            src={asset.fileUrl!}
                            alt="素材预览"
                            className="aspect-square w-full object-cover"
                          />
                          <span className="block truncate px-2 py-2 text-[10px] text-[#666a73]">
                            {asset.source}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl bg-[#f7f7f8] p-6 text-center text-xs text-[#85858e]">
                      {assets.length
                        ? "现有素材的源文件缺失，请先恢复素材卷或重新上传"
                        : "请先上传一张源素材"}
                    </div>
                  )}
                </div>
              )}
            <form key={operation} onSubmit={submit} className="mt-6 grid gap-5">
              {operation === "generate" && (
                <Field
                  label="画面需求 *"
                  hint="系统会自动加入极客跳动红白黑视觉、无文字、无 Logo 等品牌约束"
                >
                  <textarea
                    required
                    name="prompt"
                    maxLength={2000}
                    className={`${inputClass} min-h-28 resize-y py-3`}
                    placeholder="例如：企业团队与 AI 智能体协作的抽象商务场景，主体靠右，左侧留白"
                  />
                </Field>
              )}
              {operation === "xiaohongshu_cover_text" && (
                <div className="grid gap-4">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!selected[0] || ocrBusy}
                    onClick={() => void recognizeCoverText()}
                    className={ocrBusy ? "cursor-wait" : ""}
                  >
                    {ocrBusy ? (
                      <LoaderCircle size={16} className="animate-spin" />
                    ) : (
                      <PencilLine size={16} />
                    )}
                    {ocrBusy ? "正在识别封面文字…" : "识别封面文字"}
                  </Button>
                  {selected[0] && (
                    <div className="rounded-2xl border border-[#ededf0] bg-[#f6f6f7] p-3">
                      <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl bg-black">
                        <img
                          src={
                            usableAssets.find(
                              (asset) => asset.id === selected[0],
                            )?.fileUrl ?? ""
                          }
                          alt="小红书封面文字识别预览"
                          className="block max-h-[620px] max-w-full object-contain"
                        />
                        {textBlocks.map((block, index) => (
                          <button
                            key={`${block.text}-${index}`}
                            type="button"
                            title={block.text}
                            onClick={() => {
                              setSelectedTextIndex(index);
                              setTextRegion(block);
                            }}
                            className={`absolute border-2 ${selectedTextIndex === index ? "border-[#e60012] bg-[#e60012]/20" : "border-white/90 bg-black/10 hover:border-[#e60012]"}`}
                            style={{
                              left: `${block.x * 100}%`,
                              top: `${block.y * 100}%`,
                              width: `${block.width * 100}%`,
                              height: `${block.height * 100}%`,
                            }}
                          >
                            <span className="sr-only">{block.text}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {textRegion && selectedTextIndex !== null && (
                    <div className="rounded-2xl border border-[#f3d48d] bg-[#fff9e9] p-4">
                      <p className="text-xs text-[#76520b]">
                        已选中原文：
                        <strong>{textBlocks[selectedTextIndex]?.text}</strong>
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {(["x", "y", "width", "height"] as const).map(
                          (field) => (
                            <label
                              key={field}
                              className="text-[11px] text-[#76520b]"
                            >
                              {field === "x"
                                ? "左边距 %"
                                : field === "y"
                                  ? "上边距 %"
                                  : field === "width"
                                    ? "宽度 %"
                                    : "高度 %"}
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.5"
                                value={Number(
                                  (textRegion[field] * 100).toFixed(1),
                                )}
                                onChange={(event) => {
                                  const value = Math.max(
                                    0,
                                    Math.min(100, Number(event.target.value)),
                                  );
                                  setTextRegion((current) => {
                                    if (!current) return current;
                                    const normalized = value / 100;
                                    if (field === "x")
                                      return {
                                        ...current,
                                        x: Math.min(
                                          normalized,
                                          1 - current.width,
                                        ),
                                      };
                                    if (field === "y")
                                      return {
                                        ...current,
                                        y: Math.min(
                                          normalized,
                                          1 - current.height,
                                        ),
                                      };
                                    if (field === "width")
                                      return {
                                        ...current,
                                        width: Math.max(
                                          0.01,
                                          Math.min(normalized, 1 - current.x),
                                        ),
                                      };
                                    return {
                                      ...current,
                                      height: Math.max(
                                        0.01,
                                        Math.min(normalized, 1 - current.y),
                                      ),
                                    };
                                  });
                                }}
                                className={`${inputClass} mt-1 h-9 py-1`}
                              />
                            </label>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                  <Field
                    label="替换为 *"
                    hint="只消除并重绘选中文字区域，其他画面和已有 Logo 保持不变"
                  >
                    <textarea
                      required
                      name="prompt"
                      maxLength={80}
                      className={`${inputClass} min-h-20 resize-y py-3`}
                      placeholder="输入替换后必须准确显示的文字"
                    />
                  </Field>
                </div>
              )}
              {operation === "compose" && (
                <Field
                  label="融合要求（可选）"
                  hint="未说明位置或大小时，AI 会根据背景留白、透视、地面和光线自动匹配"
                >
                  <textarea
                    name="prompt"
                    maxLength={2000}
                    className={`${inputClass} min-h-24 resize-y py-3`}
                    placeholder="例如：人物脚下保留自然接触阴影，整体为温暖的商业摄影光线"
                  />
                </Field>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="输出比例">
                  {operation === "xiaohongshu_cover_text" ? (
                    <>
                      <div
                        className={`${inputClass} flex items-center bg-[#f7f7f8] text-[#666a73]`}
                      >
                        保持原图尺寸与比例
                      </div>
                      <input type="hidden" name="ratio" value="3:4" />
                    </>
                  ) : (
                    <select
                      name="ratio"
                      className={inputClass}
                      defaultValue="16:9"
                    >
                      <option>16:9</option>
                      <option>4:3</option>
                      <option>1:1</option>
                      <option>3:4</option>
                      <option>4:5</option>
                      <option value="wechat_cover">公众号封面 900×383</option>
                    </select>
                  )}
                </Field>
                {operation === "generate" ? (
                  <Field label="生成数量">
                    <select
                      name="count"
                      className={inputClass}
                      defaultValue="1"
                    >
                      <option value="1">1 张</option>
                      <option value="2">2 张</option>
                      <option value="3">3 张</option>
                      <option value="4">4 张</option>
                    </select>
                  </Field>
                ) : (
                  <input type="hidden" name="count" value="1" />
                )}
              </div>
              {["generate", "compose"].includes(operation) ? (
                <Field label="质量">
                  <select
                    name="quality"
                    className={inputClass}
                    defaultValue="high"
                  >
                    <option value="standard">标准</option>
                    <option value="high">高质量</option>
                  </select>
                </Field>
              ) : (
                <input type="hidden" name="quality" value="high" />
              )}
              <Button
                type="submit"
                disabled={
                  jobBusy ||
                  !selectionReady ||
                  (operation === "xiaohongshu_cover_text" && !textRegion)
                }
                className={jobBusy ? "cursor-wait" : ""}
              >
                {jobBusy ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <ImagePlus size={16} />
                )}{" "}
                {jobBusy ? "正在处理…" : "开始图片任务"}
              </Button>
            </form>
          </Card>
          {job && (
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-bold">任务结果</h2>
                  <p className="mt-1 text-xs text-[#85858e]">
                    {job.progress.message}
                  </p>
                </div>
                <Badge
                  tone={
                    job.status === "completed"
                      ? "green"
                      : job.status === "failed"
                        ? "red"
                        : "amber"
                  }
                >
                  {job.status}
                </Badge>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#ededf0]">
                <div
                  className="h-full bg-[#e60012]"
                  style={{ width: `${job.progress.percent}%` }}
                />
              </div>
              {job.errorCode && (
                <p className="mt-3 text-xs text-[#b90012]">
                  错误码：{job.errorCode}
                </p>
              )}
              {job.outputs.length > 0 && (
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {job.outputs
                    .filter((asset): asset is Asset & { fileUrl: string } =>
                      Boolean(asset.fileUrl),
                    )
                    .map((asset) => (
                      <a
                        key={asset.id}
                        href={asset.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="overflow-hidden rounded-2xl border border-[#ededf0] bg-[#f5f5f6]"
                      >
                        <img
                          src={asset.fileUrl}
                          alt="图片任务结果"
                          className="aspect-video w-full object-contain"
                        />
                        <span className="block px-3 py-2 text-xs font-semibold">
                          打开原图
                        </span>
                      </a>
                    ))}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      <Card className="mt-5 border-[#e6e6e9] bg-white p-6 text-[#17171a]">
        <div className="flex gap-3">
          <ShieldCheck className="shrink-0 text-[#e60012]" />
          <div>
            <h3 className="font-bold">品牌与授权边界</h3>
            <p className="mt-2 text-xs leading-5 text-[#666a73]">
              AI 生图默认无文字、无 Logo。Logo
              叠加只使用成员本次明确上传或从内容资产选中的原文件；真人、客户现场和第三方标识仍需确认授权。
            </p>
          </div>
        </div>
      </Card>
    </>
  );
}
