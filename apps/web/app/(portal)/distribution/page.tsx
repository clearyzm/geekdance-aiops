"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { csrfToken } from "@/lib/content";

const channelNames: Record<string, string> = {
  xiaohongshu: "小红书",
  zhihu: "知乎文章",
  toutiao: "今日头条",
  baijiahao: "百家号",
  linkedin: "LinkedIn",
};

type Account = {
  id: string;
  channel: string;
  displayName: string;
  status: "active" | "disabled";
  online: boolean;
  owner: { id: string; name: string };
  deviceName: string;
  lastSeenAt: string;
};
type ContentOption = {
  contentJobId: string;
  title: string;
  topic: string;
  channel: string;
  reviewedAt: string;
};
type Batch = {
  id: string;
  title: string;
  channel: string;
  mode: "draft" | "publish";
  status: string;
  createdAt: string;
  items: Array<{
    id: string;
    accountName: string;
    ownerName: string;
    status: string;
    errorCode?: string | null;
    platformUrl?: string | null;
  }>;
};

const statusLabels: Record<string, string> = {
  queued: "等待账号连接",
  running: "投放中",
  completed: "全部完成",
  partial: "部分成功",
  failed: "全部失败",
  ambiguous: "需人工核对",
  waiting_for_extension: "等待账号连接",
  uploading: "正在填写",
  filled: "已填写，待人工保存",
  drafted: "已保存草稿",
  published: "已正式发布",
  manual_review: "需人工处理",
  cancelled: "已取消",
};

function statusTone(status: string): "neutral" | "red" | "green" | "amber" {
  if (["completed", "drafted", "published"].includes(status)) return "green";
  if (["failed", "cancelled"].includes(status)) return "red";
  if (["partial", "ambiguous", "manual_review"].includes(status))
    return "amber";
  return "neutral";
}

export default function DistributionPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [contents, setContents] = useState<ContentOption[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [contentKey, setContentKey] = useState("");
  const [mode, setMode] = useState<"draft" | "publish">("draft");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accountResponse, contentResponse, batchResponse] =
        await Promise.all([
          fetch("/api/channel-accounts", { cache: "no-store" }),
          fetch("/api/delivery-content-options", { cache: "no-store" }),
          fetch("/api/delivery-batches", { cache: "no-store" }),
        ]);
      if (
        ![accountResponse, contentResponse, batchResponse].every(
          (item) => item.ok,
        )
      )
        throw new Error("多账号投放数据加载失败");
      setAccounts(
        ((await accountResponse.json()) as { accounts: Account[] }).accounts,
      );
      setContents(
        ((await contentResponse.json()) as { contents: ContentOption[] })
          .contents,
      );
      setBatches(
        ((await batchResponse.json()) as { batches: Batch[] }).batches,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const selectedContent = useMemo(
    () =>
      contents.find(
        (item) => `${item.contentJobId}:${item.channel}` === contentKey,
      ),
    [contentKey, contents],
  );
  const availableAccounts = accounts.filter(
    (account) =>
      account.status === "active" &&
      account.channel === selectedContent?.channel,
  );

  useEffect(() => {
    setSelectedAccounts([]);
    setConfirmTitle("");
    setReviewConfirmed(false);
  }, [contentKey, mode]);

  async function createBatch() {
    if (!selectedContent || !selectedAccounts.length) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const token = await csrfToken();
      const response = await fetch("/api/delivery-batches", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          contentJobId: selectedContent.contentJobId,
          channel: selectedContent.channel,
          mode,
          accountIds: selectedAccounts,
          reviewConfirmed,
          confirmTitle,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "创建投放批次失败");
      setMessage(
        mode === "draft"
          ? `已创建 ${body.accountCount} 个账号的草稿任务`
          : `已授权 ${body.accountCount} 个账号正式发布`,
      );
      setSelectedAccounts([]);
      setConfirmTitle("");
      setReviewConfirmed(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  const publishReady =
    mode === "draft" ||
    (reviewConfirmed && confirmTitle === selectedContent?.title);

  return (
    <main className="mx-auto max-w-[1480px] px-5 py-8 sm:px-8">
      <PageHeader
        eyebrow="Distribution"
        title="多账号发布"
        description="选择一篇已通过人工复核的文章，批量保存到多个平台账号草稿箱；正式发布需再次确认文章、配图和目标账号。"
        action={
          <Button
            variant="secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            刷新状态
          </Button>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="p-6 sm:p-7">
          <div className="mb-6 flex items-start gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#fff1f2] text-[#d00011]">
              <Send size={19} />
            </span>
            <div>
              <h2 className="text-lg font-bold">创建投放批次</h2>
              <p className="mt-1 text-sm leading-6 text-[#777780]">
                每个账号独立执行和记录结果，单个失败不会影响其他账号。
              </p>
            </div>
          </div>

          <div className="grid gap-5">
            <Field label="已复核文章">
              <select
                className={inputClass}
                value={contentKey}
                onChange={(event) => setContentKey(event.target.value)}
              >
                <option value="">请选择文章和渠道</option>
                {contents.map((item) => (
                  <option
                    key={`${item.contentJobId}:${item.channel}`}
                    value={`${item.contentJobId}:${item.channel}`}
                  >
                    [{channelNames[item.channel]}] {item.title}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="投放方式"
              hint="默认保存草稿；正式发布只适用于已经处理完成、可以直接上线的文章。"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["draft", "保存草稿", "账号仍可在平台后台做最后检查"],
                    ["publish", "正式发布", "扩展检测到唯一发布按钮后才会执行"],
                  ] as const
                ).map(([value, label, description]) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => setMode(value)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      mode === value
                        ? value === "publish"
                          ? "border-[#17171a] bg-[#17171a] text-white"
                          : "border-[#e60012] bg-[#fff7f8]"
                        : "border-[#e3e3e7] bg-white hover:border-[#bdbdc5]"
                    }`}
                  >
                    <strong className="block text-sm">{label}</strong>
                    <span
                      className={`mt-1.5 block text-xs leading-5 ${mode === "publish" ? "text-white/65" : "text-[#85858e]"}`}
                    >
                      {description}
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label={`目标账号${selectedContent ? ` · ${channelNames[selectedContent.channel]}` : ""}`}
            >
              {!selectedContent ? (
                <div className="rounded-2xl border border-dashed border-[#d8d8de] px-5 py-8 text-center text-sm text-[#85858e]">
                  请先选择文章和渠道
                </div>
              ) : availableAccounts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#e6b5ba] bg-[#fffafb] px-5 py-6 text-sm leading-6 text-[#8c2630]">
                  当前没有在线的{channelNames[selectedContent.channel]}
                  账号。请先到“渠道管理”，在已登录该平台的电脑上绑定账号。
                </div>
              ) : (
                <div className="grid gap-2">
                  {availableAccounts.map((account) => (
                    <label
                      key={account.id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#e5e5e8] px-4 py-3 hover:bg-[#fafafa]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAccounts.includes(account.id)}
                        onChange={(event) =>
                          setSelectedAccounts((current) =>
                            event.target.checked
                              ? [...current, account.id]
                              : current.filter((id) => id !== account.id),
                          )
                        }
                        className="h-4 w-4 accent-[#e60012]"
                      />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm">
                          {account.displayName}
                        </strong>
                        <span className="mt-0.5 block truncate text-xs text-[#85858e]">
                          {account.owner.name} · {account.deviceName}
                        </span>
                      </span>
                      <Badge tone={account.online ? "green" : "neutral"}>
                        {account.online ? "在线" : "离线，任务将等待连接"}
                      </Badge>
                    </label>
                  ))}
                </div>
              )}
            </Field>

            {mode === "publish" && selectedContent && (
              <div className="rounded-2xl border border-[#efb4ba] bg-[#fff7f8] p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle
                    className="mt-0.5 shrink-0 text-[#c40010]"
                    size={18}
                  />
                  <div className="min-w-0 flex-1">
                    <strong className="text-sm text-[#8f0010]">
                      正式发布确认
                    </strong>
                    <p className="mt-1 text-xs leading-5 text-[#8f4b53]">
                      本次操作会让文章直接对外可见。授权只绑定当前审核版本和本次账号清单，文章发生变化后必须重新确认。
                    </p>
                    <label className="mt-4 flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-[#e60012]"
                        checked={reviewConfirmed}
                        onChange={(event) =>
                          setReviewConfirmed(event.target.checked)
                        }
                      />
                      我已核对文章内容、配图和全部目标账号
                    </label>
                    <label className="mt-4 block text-xs font-semibold text-[#5f282f]">
                      输入完整标题以确认
                      <input
                        className={`${inputClass} mt-2`}
                        value={confirmTitle}
                        onChange={(event) =>
                          setConfirmTitle(event.target.value)
                        }
                        placeholder={selectedContent.title}
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-[#fff1f2] px-4 py-3 text-sm text-[#b50010]">
                {error}
              </div>
            )}
            {message && (
              <div className="rounded-xl bg-[#edf8f1] px-4 py-3 text-sm text-[#187844]">
                {message}
              </div>
            )}

            <Button
              onClick={() => void createBatch()}
              disabled={
                submitting ||
                !selectedContent ||
                selectedAccounts.length === 0 ||
                !publishReady
              }
            >
              {mode === "publish" ? (
                <ShieldCheck size={17} />
              ) : (
                <Send size={17} />
              )}
              {submitting
                ? "正在创建…"
                : mode === "publish"
                  ? `确认并发布到 ${selectedAccounts.length} 个账号`
                  : `保存到 ${selectedAccounts.length} 个账号草稿箱`}
            </Button>
          </div>
        </Card>

        <Card className="h-fit p-6">
          <div className="flex items-center gap-3">
            <Users size={18} className="text-[#e60012]" />
            <h2 className="font-bold">账号连接说明</h2>
          </div>
          <div className="mt-5 space-y-4 text-sm leading-6 text-[#666a73]">
            <p>
              每个同事只需在自己的 Chrome
              中登录平台，并在渠道管理完成一次账号绑定。
            </p>
            <p>
              运营中心不会保存平台密码、Cookie
              或验证码。扩展只领取绑定给该账号的任务。
            </p>
            <p>
              遇到验证码、登录账号变化、发布按钮不唯一或结果不明确时，任务会停止并等待人工核对。
            </p>
          </div>
        </Card>
      </div>

      <section className="mt-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">最近投放批次</h2>
          <span className="text-xs text-[#85858e]">每 15 秒自动刷新</span>
        </div>
        <div className="grid gap-4">
          {batches.length === 0 ? (
            <Card className="p-10 text-center text-sm text-[#85858e]">
              暂无多账号投放记录
            </Card>
          ) : (
            batches.map((batch) => (
              <Card key={batch.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-3 border-b border-[#ededf0] px-5 py-4">
                  <strong className="min-w-0 flex-1 truncate text-sm">
                    {batch.title}
                  </strong>
                  <Badge>{channelNames[batch.channel]}</Badge>
                  <Badge tone={batch.mode === "publish" ? "red" : "neutral"}>
                    {batch.mode === "publish" ? "正式发布" : "保存草稿"}
                  </Badge>
                  <Badge tone={statusTone(batch.status)}>
                    {statusLabels[batch.status] || batch.status}
                  </Badge>
                </div>
                <div className="divide-y divide-[#f0f0f2]">
                  {batch.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
                    >
                      {item.status === "drafted" ||
                      item.status === "published" ? (
                        <CheckCircle2 size={16} className="text-[#198754]" />
                      ) : (
                        <Clock3 size={16} className="text-[#9999a2]" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        <strong>{item.accountName}</strong>
                        <span className="ml-2 text-xs text-[#9999a2]">
                          {item.ownerName}
                        </span>
                      </span>
                      <Badge tone={statusTone(item.status)}>
                        {statusLabels[item.status] || item.status}
                      </Badge>
                      {item.platformUrl && (
                        <a
                          className="text-xs font-semibold text-[#c40010] hover:underline"
                          href={item.platformUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看平台结果
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
