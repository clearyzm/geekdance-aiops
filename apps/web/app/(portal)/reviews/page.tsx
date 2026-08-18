"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  Globe2,
  MessageCircleMore,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Card } from "@/components/ui";
import type { ManualReview } from "@/lib/content";

const channelName = {
  official_site: "官网",
  wechat: "公众号",
  xiaohongshu: "小红书",
  zhihu: "知乎文章",
  toutiao: "今日头条",
  baijiahao: "百家号",
  linkedin: "LinkedIn",
};

const resolvedStatus = {
  approved: "已通过并提交草稿创建",
  rejected: "已驳回",
  confirmed_drafted: "已确认草稿存在",
  retrying: "已确认并重试",
};

function ChannelIcon({ target }: { target: ManualReview["target"] }) {
  if (target === "official_site") return <Globe2 size={16} />;
  if (target === "wechat") return <MessageCircleMore size={16} />;
  return <BookOpen size={16} />;
}

export default function ManualReviewsPage() {
  const [tab, setTab] = useState<"pending" | "resolved">("pending");
  const [reviews, setReviews] = useState<ManualReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function load(silent = false) {
      if (!silent) setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/manual-reviews?status=${tab}`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = (await response.json()) as {
          reviews?: ManualReview[];
          message?: string;
        };
        if (!response.ok) throw new Error(data.message || "复核任务读取失败");
        if (!cancelled) setReviews(data.reviews || []);
      } catch (reason) {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : "复核任务读取失败",
          );
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = window.setTimeout(() => void load(true), 15_000);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [tab]);

  return (
    <>
      <PageHeader
        eyebrow="Manual Review"
        title="人工复核"
        description="集中修改待审文章、补充渠道配图并处理草稿结果不确定事项；所有修改和决定都会记录实际操作人。"
      />
      <div className="mb-5 inline-flex rounded-xl bg-[#ededf0] p-1">
        {(
          [
            ["pending", "待处理"],
            ["resolved", "处理记录"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              tab === value
                ? "bg-white text-[#17171a] shadow-sm"
                : "text-[#666a73]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-[#666a73]">
          正在读取复核任务…
        </Card>
      ) : error ? (
        <Card className="p-10 text-center">
          <CircleAlert className="mx-auto text-[#e60012]" />
          <p role="alert" className="mt-4 text-sm text-[#b90012]">
            {error}
          </p>
        </Card>
      ) : reviews.length === 0 ? (
        <Card className="p-12 text-center">
          {tab === "pending" ? (
            <ClipboardCheck className="mx-auto text-[#187844]" />
          ) : (
            <CheckCircle2 className="mx-auto text-[#85858e]" />
          )}
          <h2 className="mt-4 font-bold">
            {tab === "pending" ? "当前没有待复核事项" : "暂无复核记录"}
          </h2>
          <p className="mt-2 text-sm text-[#85858e]">
            {tab === "pending"
              ? "正常完成的官网和公众号草稿不会进入人工复核。"
              : "完成复核后，操作记录会显示在这里。"}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {reviews.map((review) => (
            <Card key={review.id} className="p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={review.status === "pending" ? "amber" : "neutral"}
                    >
                      {review.category === "content_quality"
                        ? "内容质量复核"
                        : "渠道结果确认"}
                    </Badge>
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#55555d]">
                      <ChannelIcon target={review.target} />
                      {channelName[review.target]}
                    </span>
                  </div>
                  <h2 className="mt-3 truncate text-base font-bold">
                    {review.job?.title || "内容任务"}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[#666a73]">
                    {review.reason}
                  </p>
                  {review.reasonCode && (
                    <p className="mt-2 break-all font-mono text-[11px] text-[#b35d00]">
                      {review.reasonCode}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-[#85858e]">
                    <span>
                      创建人：{review.job?.createdBy.name || "运营成员"}
                    </span>
                    <span>
                      进入复核：
                      {new Date(review.createdAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </span>
                    {review.reviewer && (
                      <span>
                        复核人：{review.reviewer.name || "运营成员"} ·{" "}
                        {
                          resolvedStatus[
                            review.status as keyof typeof resolvedStatus
                          ]
                        }
                      </span>
                    )}
                    {review.resolvedAt && (
                      <span>
                        处理时间：
                        {new Date(review.resolvedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </span>
                    )}
                  </div>
                  {review.revisionApplied && (
                    <p className="mt-2 text-[11px] font-semibold text-[#187844]">
                      已保存文章与配图的复核修改
                    </p>
                  )}
                  {review.target !== "xiaohongshu" &&
                    (review.externalDraftId || review.externalUrl) && (
                      <div className="mt-2 space-y-1 text-[11px] text-[#85858e]">
                        {review.externalDraftId && (
                          <p className="break-all">
                            草稿 ID：{review.externalDraftId}
                          </p>
                        )}
                        {review.externalUrl && (
                          <a
                            href={review.externalUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-semibold text-[#e60012] hover:underline"
                          >
                            打开已确认草稿
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    )}
                </div>
                <Link
                  href={`/tasks/${review.contentJobId}`}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#17171a] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#333338]"
                >
                  {review.status === "pending" ? "进入复核" : "查看详情"}
                  <ExternalLink size={14} />
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
