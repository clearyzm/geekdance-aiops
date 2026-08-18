"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ClipboardPaste,
  ExternalLink,
  ImageIcon,
  Pencil,
  LoaderCircle,
  Search,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { csrfToken } from "@/lib/content";

type Asset = {
  id: string;
  source: string;
  kind: string;
  status: string;
  mimeType: string;
  fileUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [editingAssetId, setEditingAssetId] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/assets", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return setError("素材库读取失败");
    setAssets(((await response.json()) as { assets: Asset[] }).assets);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const visible = useMemo(
    () =>
      assets.filter((asset) => {
        const matched =
          !query ||
          JSON.stringify(asset).toLowerCase().includes(query.toLowerCase());
        const category =
          filter === "全部" ||
          (filter === "上传素材" && asset.source === "upload") ||
          (filter === "AI 图片" &&
            ["mock", "openrouter", "openai"].includes(asset.source)) ||
          (filter === "工坊成果" &&
            !["upload", "mock", "openrouter", "openai"].includes(asset.source));
        return matched && category;
      }),
    [assets, query, filter],
  );
  async function remove(assetId: string) {
    if (!window.confirm("确认删除这张素材？已插入文章的历史内容不会同步删除。"))
      return;
    setDeletingId(assetId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/assets/${assetId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
      });
      if (!response.ok) throw new Error("素材删除失败");
      setAssets((current) => current.filter((asset) => asset.id !== assetId));
      setNotice("素材已删除");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材删除失败");
    } finally {
      setDeletingId(null);
    }
  }
  const assetName = (asset: Asset) =>
    String(
      asset.metadata.displayName ??
        asset.metadata.operation ??
        asset.metadata.originalName ??
        "图片素材",
    );
  async function rename(assetId: string) {
    const name = nameDraft.trim();
    if (!name) return setError("素材名称不能为空");
    if (Array.from(name).length > 80)
      return setError("素材名称不能超过 80 个字符");
    setRenaming(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/assets/${assetId}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({ name }),
      });
      const data = (await response.json()) as {
        asset?: Asset;
        message?: string;
      };
      if (!response.ok || !data.asset)
        throw new Error(data.message || "素材重命名失败");
      setAssets((current) =>
        current.map((asset) => (asset.id === assetId ? data.asset! : asset)),
      );
      setEditingAssetId("");
      setNameDraft("");
      setNotice(`素材已重命名为“${name}”`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材重命名失败");
    } finally {
      setRenaming(false);
    }
  }
  async function upload(file: File) {
    setUploading(true);
    setError("");
    setNotice("");
    try {
      if (!file.type.startsWith("image/"))
        throw new Error("仅支持 PNG、JPG 或 WebP 图片");
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/assets/upload", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
        body: form,
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          data.message ||
            (data.error === "IMAGE_TOO_LARGE"
              ? "图片不能超过 20 MiB"
              : "图片上传失败"),
        );
      setNotice(`“${file.name}”已加入共享内容资产`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="Content Library"
        title="内容资产"
        description="统一管理上传素材、AI 图片和图片工坊成果，保留来源、模型、操作与成本记录。"
        action={
          <Button asChild>
            <Link href="/image-studio">
              <WandSparkles size={16} />
              进入图片工坊
            </Link>
          </Button>
        }
      />
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-xl border border-[#f6b8be] bg-[#fff1f2] px-4 py-3 text-sm text-[#b90012]"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="mb-5 rounded-xl border border-[#bde3cb] bg-[#edf8f1] px-4 py-3 text-sm text-[#187844]"
        >
          {notice}
        </div>
      )}
      <Card className="mb-5 p-4">
        <label
          tabIndex={0}
          onPaste={(event) => {
            const file = Array.from(event.clipboardData.files).find((item) =>
              item.type.startsWith("image/"),
            );
            if (file) {
              event.preventDefault();
              void upload(file);
            }
          }}
          className="focus-ring flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#d8d8dd] bg-[#fafafa] px-4 py-4 text-sm text-[#55555d] hover:border-[#e60012]"
        >
          <Upload size={17} className="text-[#e60012]" />
          <span className="flex-1 font-semibold">
            {uploading ? "正在上传图片…" : "选择图片，或在此处直接粘贴截图"}
          </span>
          <ClipboardPaste size={16} className="text-[#85858e]" />
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
        </label>
      </Card>
      <Card>
        <div className="flex flex-col gap-3 border-b border-[#ededf0] p-4 sm:flex-row">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3.5 top-3.5 text-[#9a9aa2]"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={`${inputClass} pl-10`}
              placeholder="搜索来源、模型或操作类型"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {["全部", "上传素材", "AI 图片", "工坊成果"].map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={`rounded-xl px-3.5 py-2 text-xs font-semibold ${filter === item ? "bg-[#17171a] text-white" : "bg-[#f5f5f6] text-[#666a73]"}`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        {visible.length ? (
          <div className="grid items-stretch gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((asset) => (
              <div
                key={asset.id}
                className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-[#ededf0] bg-white"
              >
                <div className="grid aspect-[4/3] shrink-0 place-items-center bg-[#f5f5f6]">
                  {asset.fileUrl ? (
                    <img
                      src={asset.fileUrl}
                      alt="素材预览"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <ImageIcon className="text-[#aaaab2]" />
                  )}
                </div>
                <div className="flex min-h-[154px] flex-1 flex-col p-3">
                  <div className="flex h-6 shrink-0 items-center justify-between gap-2">
                    <Badge
                      tone={
                        ["openrouter", "openai"].includes(asset.source)
                          ? "red"
                          : "neutral"
                      }
                    >
                      {asset.source}
                    </Badge>
                    <span className="text-[10px] text-[#92929a]">
                      {asset.status === "missing"
                        ? "源文件缺失"
                        : new Date(asset.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  <div className="mt-2.5 h-8 shrink-0">
                    {editingAssetId === asset.id ? (
                      <div className="flex h-8 gap-1">
                        <label
                          className="sr-only"
                          htmlFor={`asset-name-${asset.id}`}
                        >
                          素材名称
                        </label>
                        <input
                          id={`asset-name-${asset.id}`}
                          autoFocus
                          value={nameDraft}
                          maxLength={80}
                          className={`${inputClass} !h-8 min-w-0 flex-1 !rounded-lg !px-2 !py-0 !text-xs`}
                          onChange={(event) => setNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void rename(asset.id);
                            }
                            if (event.key === "Escape") {
                              setEditingAssetId("");
                              setNameDraft("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          aria-label="保存素材名称"
                          disabled={renaming || !nameDraft.trim()}
                          onClick={() => void rename(asset.id)}
                          className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#17171a] text-white disabled:opacity-40"
                        >
                          {renaming ? (
                            <LoaderCircle size={14} className="animate-spin" />
                          ) : (
                            <Check size={14} />
                          )}
                        </button>
                        <button
                          type="button"
                          aria-label="取消重命名"
                          disabled={renaming}
                          onClick={() => {
                            setEditingAssetId("");
                            setNameDraft("");
                          }}
                          className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#dedee3] text-[#666a73] disabled:opacity-40"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex h-8 min-w-0 items-center gap-1.5">
                        <p
                          className="min-w-0 flex-1 truncate text-xs font-semibold"
                          title={assetName(asset)}
                        >
                          {assetName(asset)}
                        </p>
                        <button
                          type="button"
                          aria-label={`重命名${assetName(asset)}`}
                          title="修改素材名称"
                          onClick={() => {
                            setEditingAssetId(asset.id);
                            setNameDraft(assetName(asset));
                            setError("");
                          }}
                          className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[#85858e] hover:bg-[#f3f3f5] hover:text-[#17171a]"
                        >
                          <Pencil size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="mt-0.5 h-4 shrink-0 truncate text-[10px] leading-4 text-[#85858e]">
                    {String(asset.metadata.model ?? asset.mimeType ?? "")}
                  </p>
                  <div className="mt-auto flex min-h-9 items-center gap-2 pt-3">
                    {asset.fileUrl && (
                      <Button
                        asChild
                        variant="secondary"
                        className="h-9 flex-1 px-2 text-xs"
                      >
                        <a
                          href={asset.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={13} />
                          原图
                        </a>
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-9 px-3"
                      disabled={deletingId !== null}
                      onClick={() => void remove(asset.id)}
                      aria-label="删除素材"
                    >
                      {deletingId === asset.id ? (
                        <LoaderCircle size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid min-h-[360px] place-items-center p-10 text-center">
            <div>
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#fff1f2] text-[#e60012]">
                <ImageIcon size={22} />
              </span>
              <h3 className="mt-4 text-sm font-bold">暂无符合条件的素材</h3>
              <p className="mt-2 text-xs text-[#85858e]">
                在图片工坊上传或创建图片后会自动显示。
              </p>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
