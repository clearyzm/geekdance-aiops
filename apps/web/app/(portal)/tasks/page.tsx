"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Filter, RefreshCw, Search, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, inputClass } from "@/components/ui";
import { csrfToken, type ContentJob, statusMeta } from "@/lib/content";

const activeStatuses = new Set([
  "queued",
  "researching",
  "writing",
  "formatting",
  "publishing",
  "awaiting_upload",
]);

export default function TasksPage() {
  const [jobs, setJobs] = useState<ContentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/content-jobs", {
        credentials: "include",
        cache: "no-store",
      });
      const data = (await response.json()) as { jobs: ContentJob[] };
      if (response.ok) setJobs(data.jobs);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function moveToTrash(job: ContentJob) {
    if (activeStatuses.has(job.status)) return;
    if (
      !window.confirm(
        "将该任务移入回收站？官网或公众号中已经生成的草稿不会被删除。",
      )
    )
      return;
    setDeletingId(job.id);
    setError("");
    try {
      const response = await fetch(`/api/content-jobs/${job.id}/trash`, {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
      });
      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.message ?? data.error ?? "任务删除失败");
      setJobs((current) => current.filter((item) => item.id !== job.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务删除失败");
    } finally {
      setDeletingId(null);
    }
  }
  const visible = jobs.filter((job) =>
    `${job.title ?? ""} ${job.topic} ${job.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        eyebrow="Task Center"
        title="任务中心"
        description="团队共享每一次内容任务的实时阶段、质检结果和渠道草稿状态。"
        action={
          <div className="flex items-center gap-2">
            <Button asChild variant="secondary">
              <Link href="/tasks/trash">
                <Trash2 size={16} />
                回收站
              </Link>
            </Button>
            <Button variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              刷新状态
            </Button>
          </div>
        }
      />
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-[#f4c7ca] bg-[#fff5f5] px-4 py-3 text-sm text-[#b90012]"
        >
          {error}
        </p>
      )}
      <Card className="overflow-hidden">
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
              placeholder="搜索标题、主题或任务 ID"
            />
          </div>
          <Button variant="secondary" disabled>
            <Filter size={16} />
            全部状态
          </Button>
        </div>
        {visible.length ? (
          <div className="divide-y divide-[#ededf0]">
            {visible.map((job) => {
              const meta = statusMeta[job.status];
              return (
                <div key={job.id} className="group flex items-center pr-4">
                  <Link
                    href={`/tasks/${job.id}`}
                    className="grid min-w-0 flex-1 gap-4 p-5 transition hover:bg-[#fffafb] md:grid-cols-[1fr_160px_180px_24px] md:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-bold">
                          {job.result?.article?.title || job.title || job.topic}
                        </h3>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="mt-2 truncate text-xs text-[#85858e]">
                        {job.topic}
                      </p>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#ededf0]">
                        <div
                          className="h-full rounded-full bg-[#e60012] transition-all"
                          style={{ width: `${job.progress?.percent ?? 0}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-xs text-[#666a73]">
                      <strong className="block text-[#333338]">
                        {job.progress?.percent ?? 0}%
                      </strong>
                      <span>{job.progress?.message}</span>
                    </div>
                    <div className="text-xs text-[#85858e]">
                      <strong className="block text-[#55555d]">
                        {job.input.targets
                          .map(
                            (target) =>
                              ({
                                official_site: "官网",
                                wechat: "公众号",
                                xiaohongshu: "小红书",
                                zhihu: "知乎文章",
                                toutiao: "今日头条",
                                baijiahao: "百家号",
                                linkedin: "LinkedIn",
                              })[target],
                          )
                          .join(" + ")}
                      </strong>
                      <span>
                        {new Date(job.createdAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </span>
                      <span className="mt-1 block">
                        创建人：{job.createdBy.name || "运营成员"}
                      </span>
                    </div>
                    <ArrowRight
                      size={18}
                      className="text-[#b4b4ba] transition group-hover:translate-x-1 group-hover:text-[#e60012]"
                    />
                  </Link>
                  {job.canManage && (
                    <button
                      type="button"
                      title={
                        activeStatuses.has(job.status)
                          ? "运行中的任务需要先取消"
                          : "移入回收站"
                      }
                      aria-label="移入回收站"
                      disabled={
                        activeStatuses.has(job.status) || deletingId !== null
                      }
                      onClick={() => void moveToTrash(job)}
                      className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#85858e] transition hover:bg-[#fff1f2] hover:text-[#c40010] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {deletingId === job.id ? (
                        <RefreshCw size={17} className="animate-spin" />
                      ) : (
                        <Trash2 size={17} />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-[420px] place-items-center p-10 text-center">
            <div>
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#f5f5f6] text-[#85858e]">
                <RefreshCw
                  size={22}
                  className={loading ? "animate-spin" : ""}
                />
              </span>
              <h3 className="mt-4 text-sm font-bold">
                {loading ? "正在读取任务" : "暂无任务记录"}
              </h3>
              <p className="mt-2 text-xs text-[#85858e]">
                从 AI 内容生产提交第一个任务后，会在这里显示实时进度。
              </p>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
