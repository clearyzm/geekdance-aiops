"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card } from "@/components/ui";
import { csrfToken, type ContentJob, statusMeta } from "@/lib/content";

export default function TaskTrashPage() {
  const [jobs, setJobs] = useState<ContentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/content-jobs?view=trash", {
        credentials: "include",
        cache: "no-store",
      });
      const data = (await response.json()) as {
        jobs?: ContentJob[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "回收站读取失败");
      setJobs(data.jobs ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "回收站读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(job: ContentJob) {
    setActingId(job.id);
    setError("");
    try {
      const response = await fetch(`/api/content-jobs/${job.id}/restore`, {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
      });
      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.message ?? data.error ?? "任务恢复失败");
      setJobs((current) => current.filter((item) => item.id !== job.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务恢复失败");
    } finally {
      setActingId(null);
    }
  }

  async function permanentlyDelete(job: ContentJob) {
    if (
      !window.confirm(
        "永久删除后无法恢复。该操作只删除运营中心的任务记录，不会删除官网或公众号中的渠道草稿。确定继续吗？",
      )
    )
      return;
    setActingId(job.id);
    setError("");
    try {
      const response = await fetch(`/api/content-jobs/${job.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "x-csrf-token": await csrfToken() },
      });
      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.message ?? data.error ?? "任务永久删除失败");
      setJobs((current) => current.filter((item) => item.id !== job.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务永久删除失败");
    } finally {
      setActingId(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Task Trash"
        title="任务回收站"
        description="恢复误删任务，或永久清理不再需要的运营记录。渠道草稿不会随任务记录删除。"
        action={
          <div className="flex items-center gap-2">
            <Button asChild variant="secondary">
              <Link href="/tasks">
                <ArrowLeft size={16} />
                返回任务中心
              </Link>
            </Button>
            <Button variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              刷新
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
        {jobs.length ? (
          <div className="divide-y divide-[#ededf0]">
            {jobs.map((job) => {
              const meta = statusMeta[job.status];
              const busy = actingId === job.id;
              const actionInFlight = actingId !== null;
              return (
                <div
                  key={job.id}
                  className="grid gap-4 p-5 md:grid-cols-[1fr_190px_auto] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-bold">
                        {job.result?.article?.title || job.title || job.topic}
                      </h2>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    <p className="mt-2 truncate text-xs text-[#85858e]">
                      {job.topic}
                    </p>
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
                      删除于：
                      {new Date(job.deletedAt ?? job.updatedAt).toLocaleString(
                        "zh-CN",
                        { hour12: false },
                      )}
                    </span>
                    <span className="mt-1 block">
                      创建人：{job.createdBy.name || "运营成员"}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {job.canManage ? (
                      <>
                        <Button
                          variant="secondary"
                          disabled={actionInFlight}
                          onClick={() => void restore(job)}
                        >
                          {busy ? (
                            <RefreshCw size={15} className="animate-spin" />
                          ) : (
                            <RotateCcw size={15} />
                          )}
                          {busy ? "处理中…" : "恢复"}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={actionInFlight}
                          onClick={() => void permanentlyDelete(job)}
                        >
                          {busy ? (
                            <RefreshCw size={15} className="animate-spin" />
                          ) : (
                            <Trash2 size={15} />
                          )}
                          {busy ? "处理中…" : "永久删除"}
                        </Button>
                      </>
                    ) : (
                      <Badge>只读</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-[420px] place-items-center p-10 text-center">
            <div>
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#f5f5f6] text-[#85858e]">
                <Trash2 size={22} />
              </span>
              <h3 className="mt-4 text-sm font-bold">
                {loading ? "正在读取回收站" : "回收站为空"}
              </h3>
              <p className="mt-2 text-xs text-[#85858e]">
                从任务中心移除的任务会暂存在这里。
              </p>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
