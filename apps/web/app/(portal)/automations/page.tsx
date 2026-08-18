"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  Clock3,
  History,
  LoaderCircle,
  Play,
  Plus,
  Power,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { csrfToken } from "@/lib/content";

type Schedule = {
  id: string;
  name: string;
  enabled: boolean;
  cronExpression: string;
  timezone: "Asia/Shanghai";
  template: {
    topic: string;
    title?: string;
    readerMode: "general" | "professional";
    sourceRefs: string[];
    imageMode: "geekhome" | "generated";
    includeGeekHome?: boolean;
    primaryTag?: string;
    secondaryTags?: string[];
    remarks?: string;
    targets?: Array<
      | "official_site"
      | "wechat"
      | "xiaohongshu"
      | "zhihu"
      | "toutiao"
      | "baijiahao"
      | "linkedin"
    >;
  };
  lastTriggeredAt?: string | null;
  lastJobId?: string | null;
};

async function mutate(url: string, method: string, body?: unknown) {
  const token = await csrfToken();
  const response = await fetch(url, {
    method,
    credentials: "include",
    headers: {
      "x-csrf-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "操作失败");
  return data;
}

export default function AutomationsPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState("");
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/automation-schedules", {
      credentials: "include",
      cache: "no-store",
    });
    const data = (await response.json()) as { schedules?: Schedule[] };
    if (response.ok) setSchedules(data.schedules ?? []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(schedule: Schedule) {
    const key = `toggle:${schedule.id}`;
    setActionKey(key);
    setError("");
    setNotice("");
    try {
      await mutate(`/api/admin/automation-schedules/${schedule.id}`, "PATCH", {
        ...schedule,
        enabled: !schedule.enabled,
      });
      setNotice(
        schedule.enabled
          ? "定时任务已停用"
          : "定时任务已启用，将按上海时区创建所选渠道草稿",
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setActionKey("");
    }
  }

  async function runNow(schedule: Schedule) {
    const key = `run:${schedule.id}`;
    setActionKey(key);
    setError("");
    setNotice("");
    try {
      await mutate(
        `/api/admin/automation-schedules/${schedule.id}/run`,
        "POST",
      );
      setNotice("已提交一次立即运行任务，请到任务中心查看进度");
      window.setTimeout(load, 800);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setActionKey("");
    }
  }

  async function remove(schedule: Schedule) {
    if (
      !window.confirm(
        `确认删除定时任务“${schedule.name}”？已生成的内容任务和渠道草稿不会被删除。`,
      )
    )
      return;
    setError("");
    setNotice("");
    setDeletingId(schedule.id);
    try {
      await mutate(`/api/admin/automation-schedules/${schedule.id}`, "DELETE");
      setNotice("定时任务已删除，历史内容任务和渠道草稿保持不变");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const [hourText, minuteText] = String(form.get("time") || "08:00").split(
      ":",
    );
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const targets = form
      .getAll("targets")
      .map(String) as NonNullable<Schedule["template"]["targets"]>;
    if (!targets.length) return setError("请至少选择一个草稿渠道");
    if (
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    )
      return setError("请选择有效的每日执行时间");
    setCreating(true);
    try {
      await mutate("/api/admin/automation-schedules", "POST", {
        name: form.get("name"),
        enabled: false,
        cronExpression: `${minute} ${hour} * * *`,
        timezone: "Asia/Shanghai",
        template: {
          topic: form.get("topic"),
          readerMode: form.get("readerMode"),
          sourceRefs: [],
          imageMode: "generated",
          includeGeekHome: form.get("includeGeekHome") === "on",
          primaryTag: String(form.get("primaryTag") || "") || undefined,
          secondaryTags: [],
          targets,
          remarks: "定时生成所选渠道内容并进入人工复核",
        },
      });
      formElement.reset();
      setNotice("定时任务已创建，初始为停用状态");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Automation Schedules"
        title="定时任务"
        description="设置每日任意时刻，按上海时区为全部七个渠道自动生成文章并进入人工复核。"
      />
      {(notice || error) && (
        <div
          role={error ? "alert" : "status"}
          className={`mb-5 rounded-2xl border px-4 py-3 text-sm ${error ? "border-[#f6b8be] bg-[#fff1f2] text-[#b90012]" : "border-[#bde3cb] bg-[#edf8f1] text-[#187844]"}`}
        >
          {error || notice}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[1.35fr_.7fr]">
        <div className="space-y-4">
          {loading ? (
            <Card className="p-8 text-sm text-[#85858e]">
              正在读取定时任务…
            </Card>
          ) : (
            schedules.map((schedule) => {
              const parts = schedule.cronExpression.split(" ");
              const time = `${String(Number(parts[1] ?? 8)).padStart(2, "0")}:${String(Number(parts[0] ?? 0)).padStart(2, "0")}`;
              const targets = schedule.template.targets?.length
                ? schedule.template.targets
                : ["official_site"];
              const rowBusy = Boolean(actionKey || deletingId);
              return (
                <Card key={schedule.id} className="p-6">
                  <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`grid h-10 w-10 place-items-center rounded-xl ${schedule.enabled ? "bg-[#fff1f2] text-[#e60012]" : "bg-[#f2f2f4] text-[#85858e]"}`}
                        >
                          <CalendarClock size={19} />
                        </span>
                        <h2 className="font-bold">{schedule.name}</h2>
                        <Badge tone={schedule.enabled ? "green" : "neutral"}>
                          {schedule.enabled ? "运行中" : "已停用"}
                        </Badge>
                      </div>
                      <p className="mt-4 text-sm leading-6 text-[#55555d]">
                        {schedule.template.topic}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-3 text-xs text-[#85858e]">
                        <span className="inline-flex items-center gap-1.5">
                          <Clock3 size={14} />
                          每天 {time} · 上海时区
                        </span>
                        <span>
                          {targets
                            .map((target) =>
                              target === "official_site"
                                ? "官网"
                                : target === "wechat"
                                  ? "公众号"
                                  : target === "xiaohongshu"
                                    ? "小红书"
                                    : target === "zhihu"
                                      ? "知乎"
                                      : target === "toutiao"
                                        ? "今日头条"
                                        : target === "baijiahao"
                                          ? "百家号"
                                          : "LinkedIn",
                            )
                            .join(" + ")}
                        </span>
                        <span>
                          AI 章节结构插图
                          {schedule.template.includeGeekHome
                            ? " + GeekHome 可选素材"
                            : ""}
                        </span>
                      </div>
                      {schedule.lastTriggeredAt && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-[#85858e]">
                          <History size={14} />
                          最近执行：
                          {new Date(schedule.lastTriggeredAt).toLocaleString(
                            "zh-CN",
                            { hour12: false },
                          )}
                          {schedule.lastJobId && (
                            <Link
                              href={`/tasks/${schedule.lastJobId}`}
                              className="font-semibold text-[#e60012]"
                            >
                              查看任务
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={rowBusy}
                        onClick={() => runNow(schedule)}
                      >
                        {actionKey === `run:${schedule.id}` ? (
                          <LoaderCircle size={15} className="animate-spin" />
                        ) : (
                          <Play size={15} />
                        )}
                        {actionKey === `run:${schedule.id}`
                          ? "提交中…"
                          : "立即运行"}
                      </Button>
                      <Button
                        type="button"
                        variant={schedule.enabled ? "danger" : "primary"}
                        disabled={rowBusy}
                        onClick={() => toggle(schedule)}
                      >
                        {actionKey === `toggle:${schedule.id}` ? (
                          <LoaderCircle size={15} className="animate-spin" />
                        ) : (
                          <Power size={15} />
                        )}
                        {actionKey === `toggle:${schedule.id}`
                          ? "更新中…"
                          : schedule.enabled
                            ? "停用"
                            : "启用"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={rowBusy}
                        onClick={() => void remove(schedule)}
                      >
                        {deletingId === schedule.id ? (
                          <LoaderCircle size={15} className="animate-spin" />
                        ) : (
                          <Trash2 size={15} />
                        )}
                        {deletingId === schedule.id ? "删除中…" : "删除"}
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
        <div className="space-y-5">
          <Card className="p-6">
            <div className="flex items-center gap-2">
              <Plus size={18} className="text-[#e60012]" />
              <h2 className="font-bold">新建每日任务</h2>
            </div>
            <form onSubmit={create} className="mt-5 grid gap-4">
              <Field label="任务名称">
                <input
                  required
                  name="name"
                  maxLength={80}
                  className={inputClass}
                  placeholder="例如：每日 AI 趋势草稿"
                />
              </Field>
              <Field label="选题规则">
                <textarea
                  required
                  name="topic"
                  maxLength={300}
                  className={`${inputClass} min-h-28 py-3`}
                  placeholder="描述每天应关注的方向"
                />
              </Field>
              <Field
                label="每日执行时间"
                hint="可设置 00:00–23:59 的任意时刻，按上海时区执行"
              >
                <input
                  required
                  type="time"
                  name="time"
                  step="60"
                  defaultValue="08:00"
                  className={inputClass}
                />
              </Field>
              <Field label="草稿渠道">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <label className="flex items-center gap-2 rounded-xl border border-[#ededf0] px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      name="targets"
                      value="official_site"
                      defaultChecked
                      className="accent-[#e60012]"
                    />
                    官网
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-[#ededf0] px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      name="targets"
                      value="wechat"
                      className="accent-[#e60012]"
                    />
                    公众号
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-[#ededf0] px-3 py-3 text-sm">
                    <input
                      type="checkbox"
                      name="targets"
                      value="xiaohongshu"
                      className="accent-[#e60012]"
                    />
                    小红书
                  </label>
                  {[
                    ["zhihu", "知乎"],
                    ["toutiao", "今日头条"],
                    ["baijiahao", "百家号"],
                    ["linkedin", "LinkedIn"],
                  ].map(([value, label]) => (
                    <label
                      key={value}
                      className="flex items-center gap-2 rounded-xl border border-[#ededf0] px-3 py-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        name="targets"
                        value={value}
                        className="accent-[#e60012]"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="读者模式">
                <select
                  name="readerMode"
                  className={inputClass}
                  defaultValue="general"
                >
                  <option value="general">普适模式</option>
                  <option value="professional">专业模式</option>
                </select>
              </Field>
              <Field label="图片策略">
                <div className="rounded-xl border border-[#dedee3] bg-white p-3 text-xs leading-5 text-[#55555d]">
                  <strong className="block text-[#17171a]">
                    AI 章节结构插图 · 默认启用
                  </strong>
                  包含章节标题、关键要点与结构关系，不生成空泛仿真实景。
                  <label className="mt-3 flex items-start gap-2 rounded-lg bg-[#f7f7f8] p-2.5">
                    <input
                      type="checkbox"
                      name="includeGeekHome"
                      className="mt-0.5 accent-[#e60012]"
                    />
                    <span>
                      同时检索 GeekHome（生成后暂停，等待人工选择素材用途）
                    </span>
                  </label>
                </div>
              </Field>
              <Field label="一级标签">
                <input
                  name="primaryTag"
                  className={inputClass}
                  placeholder="AI 应用"
                />
              </Field>
              <Button type="submit" disabled={creating}>
                {creating ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <Plus size={16} />
                )}
                {creating ? "正在创建…" : "创建定时任务"}
              </Button>
              <p className="text-xs leading-5 text-[#85858e]">
                新任务默认停用。确认选题、时间、渠道和模型配置后，再手动启用。
              </p>
            </form>
          </Card>
          <Card className="border-[#f6b8be] bg-[#fffafb] p-6">
            <div className="flex gap-3">
              <ShieldCheck
                size={19}
                className="mt-0.5 shrink-0 text-[#e60012]"
              />
              <div>
                <h3 className="text-sm font-bold">草稿安全边界</h3>
                <p className="mt-2 text-xs leading-5 text-[#666a73]">
                  每天只生成一次；重复触发会复用同一
                  operationId。所有渠道先进入人工复核；正式发布只能从多账号发布模块完成强确认授权。
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
