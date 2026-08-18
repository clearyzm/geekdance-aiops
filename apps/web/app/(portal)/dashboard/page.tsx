"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  BookOpen,
  Clock3,
  FileCheck2,
  Globe2,
  MessageCircleMore,
  Plus,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card } from "@/components/ui";
import { type Channel, type ContentJob, statusMeta } from "@/lib/content";

type DashboardData = {
  metrics: {
    todayJobs: number;
    pendingReviews: number;
    enabledAutomations: number;
    totalAutomations: number;
    activeChannels: number;
  };
  automation: {
    lastTriggeredAt: string | null;
    latestRun: {
      name: string;
      status: string;
      scheduledFor: string;
      contentJobId: string | null;
    } | null;
  };
  recentJobs: ContentJob[];
  channels: Array<{
    id: Channel;
    name: string;
    type: string;
    status: string;
  }>;
};

const channelStatus = {
  live: { label: "已接入", tone: "green" as const, dot: "bg-[#24a362]" },
  degraded: { label: "需检查", tone: "amber" as const, dot: "bg-[#d99a13]" },
  mock: { label: "未启用", tone: "neutral" as const, dot: "bg-[#d6d6da]" },
  not_configured: {
    label: "待配置",
    tone: "neutral" as const,
    dot: "bg-[#d6d6da]",
  },
};

const automationRunStatus: Record<string, string> = {
  queued: "排队中",
  submitted: "已提交",
  drafted: "草稿已创建",
  awaiting_upload: "等待浏览器草稿助手",
  awaiting_manual_save: "已上传，等待人工暂存",
  partial: "部分草稿成功",
  manual_review: "等待人工复核",
  cancelled: "已取消",
  failed: "执行失败",
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => {
    void fetch("/api/dashboard", { credentials: "include", cache: "no-store" })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("dashboard")),
      )
      .then((payload: DashboardData) => setData(payload))
      .catch(() => setData(null));
  }, []);
  const metrics = [
    {
      label: "今日任务",
      value: data ? String(data.metrics.todayJobs) : "—",
      note: "当日提交的内容任务",
      icon: Zap,
      tone: "bg-[#fff1f2] text-[#e60012]",
    },
    {
      label: "待人工复核",
      value: data ? String(data.metrics.pendingReviews) : "—",
      note: "需要运营人员处理的渠道任务",
      icon: FileCheck2,
      tone: "bg-[#f0f5ff] text-[#3867d6]",
    },
    {
      label: "已启用自动化",
      value: data
        ? `${data.metrics.enabledAutomations} / ${data.metrics.totalAutomations}`
        : "—",
      note: "已启用计划 / 全部计划",
      icon: Clock3,
      tone: "bg-[#edf8f1] text-[#187844]",
    },
    {
      label: "真实可用渠道",
      value: data ? `${data.metrics.activeChannels} / 6` : "—",
      note: "服务端与草稿助手已接入渠道",
      icon: TrendingUp,
      tone: "bg-[#fff6df] text-[#8a5c00]",
    },
  ];
  return (
    <>
      <PageHeader
        eyebrow="Operations Overview"
        title="早上好，准备开始今天的内容创作"
        description="在一个工作台完成选题、写作、配图、排版与多渠道草稿创建。所有正式发布仍由运营人员在渠道后台确认。"
        action={
          <Button asChild>
            <Link href="/content/create">
              <Plus size={17} />
              创建内容任务
            </Link>
          </Button>
        }
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, note, icon: Icon, tone }) => (
          <Card key={label} className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-[#666a73]">{label}</p>
                <strong className="mt-3 block text-[30px] tracking-[-.04em]">
                  {value}
                </strong>
              </div>
              <span
                className={`grid h-11 w-11 place-items-center rounded-2xl ${tone}`}
              >
                <Icon size={20} />
              </span>
            </div>
            <p className="mt-4 text-xs text-[#92929a]">{note}</p>
          </Card>
        ))}
      </section>
      <section className="mt-5 grid gap-5 xl:grid-cols-[1.55fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#ededf0] px-6 py-5">
            <div>
              <h2 className="font-bold">最近任务</h2>
              <p className="mt-1 text-xs text-[#85858e]">
                实时跟踪内容生产与渠道写入状态
              </p>
            </div>
            <Link
              href="/tasks"
              className="flex items-center gap-1 text-xs font-semibold text-[#e60012]"
            >
              查看全部
              <ArrowRight size={14} />
            </Link>
          </div>
          {data?.recentJobs.length ? (
            <div className="divide-y divide-[#ededf0]">
              {data.recentJobs.map((job) => {
                const meta = statusMeta[job.status];
                return (
                  <Link
                    key={job.id}
                    href={`/tasks/${job.id}`}
                    className="flex items-center justify-between gap-4 px-6 py-4 transition hover:bg-[#fffafb]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <strong className="truncate text-sm">
                          {job.result?.article?.title || job.title || job.topic}
                        </strong>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-[#85858e]">
                        {job.progress.message} ·{" "}
                        {new Date(job.createdAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </p>
                    </div>
                    <ArrowRight size={16} className="shrink-0 text-[#b4b4ba]" />
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-[308px] place-items-center p-8 text-center">
              <div>
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#fff1f2] text-[#e60012]">
                  <Sparkles size={24} />
                </span>
                <h3 className="mt-4 text-sm font-bold">
                  {data ? "还没有内容任务" : "正在读取任务"}
                </h3>
                <p className="mt-2 text-xs leading-5 text-[#85858e]">
                  创建任务后，检索、写作、排版和渠道状态会显示在这里。
                </p>
                {data && (
                  <Button asChild variant="secondary" className="mt-5 h-9">
                    <Link href="/content/create">开始创建</Link>
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>
        <div className="grid gap-5">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">渠道健康</h2>
                <p className="mt-1 text-xs text-[#85858e]">当前运行模式</p>
              </div>
              <Badge
                tone={
                  data?.channels.some((channel) => channel.status === "live")
                    ? "green"
                    : "amber"
                }
              >
                {data?.channels.some((channel) => channel.status === "live")
                  ? "已接入"
                  : "待接入"}
              </Badge>
            </div>
            <div className="mt-5 space-y-4">
              {(data?.channels ?? []).map((channel) => {
                const state =
                  channelStatus[channel.status as keyof typeof channelStatus] ??
                  channelStatus.not_configured;
                const Icon =
                  channel.id === "official_site"
                    ? Globe2
                    : channel.id === "wechat"
                      ? MessageCircleMore
                      : BookOpen;
                return (
                  <div key={channel.id} className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f5f5f6] text-[#44444b]">
                      <Icon size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <strong className="block text-sm">{channel.name}</strong>
                      <span className="text-xs text-[#92929a]">
                        {channel.type}
                      </span>
                    </div>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <span className={`h-2.5 w-2.5 rounded-full ${state.dot}`} />
                  </div>
                );
              })}
            </div>
          </Card>
          <Card className="overflow-hidden bg-[#17171a] p-6 text-white">
            <div className="relative z-10">
              <span className="flex items-center gap-2 text-xs font-semibold text-[#ff6874]">
                <Clock3 size={14} />
                自动化运行
              </span>
              <p className="mt-3 text-sm font-semibold leading-6">
                {data?.automation.latestRun
                  ? `${data.automation.latestRun.name} · ${automationRunStatus[data.automation.latestRun.status] ?? data.automation.latestRun.status}`
                  : "尚无自动化执行记录"}
              </p>
              <p className="mt-2 text-xs leading-5 text-white/50">
                {data?.automation.lastTriggeredAt
                  ? `最近执行 ${new Date(data.automation.lastTriggeredAt).toLocaleString("zh-CN", { hour12: false })}`
                  : "启用计划后，最近执行状态会显示在这里"}
              </p>
              <p className="mt-3 text-xs leading-5 text-white/70">
                自动化只创建草稿；失败或素材不足时进入人工复核。
              </p>
              <Link
                href="/automations"
                className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-[#ff6874]"
              >
                管理定时任务 <ArrowRight size={14} />
              </Link>
            </div>
          </Card>
        </div>
      </section>
      <section className="mt-5 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: CheckCircle2,
            title: "事实先核验",
            text: "公开资料与内部附件形成证据清单",
          },
          {
            icon: Sparkles,
            title: "品牌化创作",
            text: "极客跳动语气、排版和去 AI 味",
          },
          {
            icon: FileCheck2,
            title: "草稿可追踪",
            text: "七渠道独立结果与安全失败处理",
          },
        ].map(({ icon: Icon, title, text }) => (
          <div
            key={title}
            className="flex gap-3 rounded-2xl border border-[#e6e6e9] bg-white px-5 py-4"
          >
            <Icon size={19} className="mt-0.5 shrink-0 text-[#e60012]" />
            <div>
              <strong className="text-sm">{title}</strong>
              <p className="mt-1 text-xs leading-5 text-[#85858e]">{text}</p>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
