"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  Bot,
  BookOpen,
  ClipboardPaste,
  Globe2,
  ImageIcon,
  Link2,
  MessageCircleMore,
  Paperclip,
  Send,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { csrfToken, type Channel } from "@/lib/content";

const FALLBACK_DEFAULT_REMARKS =
  "请以事实和可验证资料为基础，使用极客跳动专业、克制、清晰的表达；优先解释业务问题、实施路径、边界与风险，避免空泛口号、夸张承诺、虚构案例和明显 AI 腔。标题与正文保持一致，段落简洁，结论给出可执行建议。";

export default function ContentCreatePage() {
  const router = useRouter();
  const [targets, setTargets] = useState<Channel[]>([
    "official_site",
    "wechat",
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [readerMode, setReaderMode] = useState<"general" | "professional">(
    "general",
  );
  const [remarks, setRemarks] = useState(FALLBACK_DEFAULT_REMARKS);
  const [savedDefaultRemarks, setSavedDefaultRemarks] = useState(
    FALLBACK_DEFAULT_REMARKS,
  );
  const [defaultRemarksLoaded, setDefaultRemarksLoaded] = useState(false);
  const [savingDefaultRemarks, setSavingDefaultRemarks] = useState(false);
  const [defaultRemarksFeedback, setDefaultRemarksFeedback] = useState("");
  const [candidateTitles, setCandidateTitles] = useState<string[]>([]);
  const [generatingTitles, setGeneratingTitles] = useState(false);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [sourceRefs, setSourceRefs] = useState("");
  const [primaryTag, setPrimaryTag] = useState("");
  const [secondaryTags, setSecondaryTags] = useState("");
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const remarksEditedRef = useRef(false);
  const uploadedAttachmentIds = useRef(new Map<string, string>());
  const [contentType, setContentType] = useState<"general" | "case">("general");
  const [includeGeekHome, setIncludeGeekHome] = useState(false);
  const [caseVisualTypes, setCaseVisualTypes] = useState([
    "cover",
    "function",
    "architecture",
  ]);
  const titleLength = Array.from(title.trim()).length;
  const wechatSelected = targets.includes("wechat");
  const xiaohongshuSelected = targets.includes("xiaohongshu");
  const thirtyCharacterPlatformSelected =
    targets.includes("toutiao") || targets.includes("baijiahao");
  const titleLimit = xiaohongshuSelected
    ? 20
    : thirtyCharacterPlatformSelected
      ? 30
      : wechatSelected
        ? 32
        : 120;
  const titleTooLong = titleLength > titleLimit;
  const titleLimitLabel = xiaohongshuSelected
    ? "小红书"
    : thirtyCharacterPlatformSelected
      ? "今日头条/百家号"
      : wechatSelected
        ? "公众号"
        : "官网/知乎/LinkedIn";

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/content-preferences?_=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("DEFAULT_REMARKS_LOAD_FAILED");
        const data = (await response.json()) as { defaultRemarks?: string };
        if (!cancelled && data.defaultRemarks) {
          setSavedDefaultRemarks(data.defaultRemarks);
          if (!remarksEditedRef.current) setRemarks(data.defaultRemarks);
        }
      })
      .catch(() => {
        if (!cancelled)
          setDefaultRemarksFeedback(
            "默认指令读取失败，当前显示系统预设；可修改后重新保存",
          );
      })
      .finally(() => {
        if (!cancelled) setDefaultRemarksLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function generateTitles() {
    if (topic.trim().length < 2) {
      setError("请先填写内容主题，再生成候选标题");
      return;
    }
    if (!targets.length) {
      setError("请先选择目标渠道");
      return;
    }
    setGeneratingTitles(true);
    setError("");
    try {
      const attachmentIds = await uploadSelectedAttachments();
      const response = await fetch("/api/content-title-candidates", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({
          topic: topic.trim(),
          targets,
          readerMode,
          remarks: remarks.trim() || undefined,
          contentType,
          sourceRefs: sourceRefs
            .split(/\n|，|,/)
            .map((value) => value.trim())
            .filter(Boolean),
          attachmentIds,
          primaryTag: primaryTag.trim() || undefined,
          secondaryTags: secondaryTags
            .split(/，|,/)
            .map((value) => value.trim())
            .filter(Boolean),
          count: 12,
        }),
      });
      const data = (await response.json()) as {
        titles?: string[];
        message?: string;
      };
      if (!response.ok || !data.titles?.length)
        throw new Error(data.message ?? "候选标题生成失败");
      setCandidateTitles(data.titles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "候选标题生成失败");
    } finally {
      setGeneratingTitles(false);
    }
  }

  async function saveDefaultRemarks() {
    const value = remarks.trim();
    if (value.length < 20) {
      setDefaultRemarksFeedback("默认指令至少需要 20 个字");
      return;
    }
    setSavingDefaultRemarks(true);
    setDefaultRemarksFeedback("");
    try {
      const response = await fetch("/api/content-preferences", {
        method: "PUT",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": await csrfToken(),
        },
        body: JSON.stringify({ defaultRemarks: value }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        defaultRemarks?: string;
        message?: string;
      };
      if (response.status === 401) {
        setDefaultRemarksFeedback("登录状态已失效，正在前往登录页");
        router.replace("/login");
        return;
      }
      if (!response.ok || !data.defaultRemarks)
        throw new Error(data.message ?? "保存失败，请稍后重试");
      const verificationResponse = await fetch(
        `/api/content-preferences?_=${Date.now()}`,
        {
          credentials: "include",
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
        },
      );
      const verification = (await verificationResponse
        .json()
        .catch(() => ({}))) as { defaultRemarks?: string; message?: string };
      if (verificationResponse.status === 401) {
        setDefaultRemarksFeedback("登录状态已失效，正在前往登录页");
        router.replace("/login");
        return;
      }
      if (
        !verificationResponse.ok ||
        verification.defaultRemarks?.trim() !== data.defaultRemarks.trim()
      )
        throw new Error("服务器未确认保存结果，请重试");
      setSavedDefaultRemarks(verification.defaultRemarks);
      setRemarks(verification.defaultRemarks);
      setDefaultRemarksFeedback(
        "已保存，刷新页面或下次创建任务时仍会使用此指令",
      );
    } catch (reason) {
      setDefaultRemarksFeedback(
        reason instanceof Error ? reason.message : "保存失败，请稍后重试",
      );
    } finally {
      setSavingDefaultRemarks(false);
    }
  }

  function toggleTarget(target: Channel) {
    setCandidateTitles([]);
    setTargets((current) =>
      current.includes(target)
        ? current.filter((item) => item !== target)
        : [...current, target],
    );
  }

  function acceptAttachmentFiles(files: File[]) {
    const accepted = files
      .filter(
        (file) =>
          /(?:pdf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain|text\/markdown|image\/(?:png|jpeg))/i.test(
            file.type,
          ) || /\.(?:pdf|docx|txt|md|png|jpe?g)$/i.test(file.name),
      )
      .slice(0, 10);
    if (!accepted.length) {
      setError(
        "粘贴内容中没有可用的 PDF、DOCX、TXT、Markdown、PNG 或 JPG 文件",
      );
      return;
    }
    setAttachmentFiles((current) => {
      const merged = [...current];
      for (const file of accepted) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (
          !merged.some(
            (item) => `${item.name}:${item.size}:${item.lastModified}` === key,
          )
        )
          merged.push(file);
      }
      return merged.slice(0, 10);
    });
    setCandidateTitles([]);
    setError("");
  }

  const attachmentKey = (file: File) =>
    `${file.name}:${file.size}:${file.lastModified}`;

  async function uploadAttachment(file: File) {
    const key = attachmentKey(file);
    const cached = uploadedAttachmentIds.current.get(key);
    if (cached) return cached;
    if (file.size > 20 * 1024 * 1024)
      throw new Error(`附件“${file.name}”超过 20 MiB`);
    const uploadBody = new FormData();
    uploadBody.append("file", file);
    const uploadResponse = await fetch("/api/attachments/upload", {
      method: "POST",
      credentials: "include",
      headers: { "x-csrf-token": await csrfToken() },
      body: uploadBody,
    });
    const uploadData = (await uploadResponse.json()) as {
      attachment?: { id: string };
      error?: string;
      message?: string;
    };
    if (!uploadResponse.ok || !uploadData.attachment)
      throw new Error(
        uploadData.message ??
          {
            ATTACHMENT_PARSE_FAILED: `附件“${file.name}”无法解析`,
            ATTACHMENT_TEXT_EMPTY: `附件“${file.name}”没有可读取的文字`,
            ATTACHMENT_TOO_LARGE: `附件“${file.name}”超过 20 MiB`,
            INVALID_ATTACHMENT_FILE: `附件“${file.name}”格式或文件内容不匹配`,
          }[uploadData.error ?? ""] ??
          `附件“${file.name}”上传失败`,
      );
    uploadedAttachmentIds.current.set(key, uploadData.attachment.id);
    return uploadData.attachment.id;
  }

  async function uploadSelectedAttachments() {
    const ids: string[] = [];
    for (const file of attachmentFiles) ids.push(await uploadAttachment(file));
    return ids;
  }

  function removeAttachment(index: number) {
    const file = attachmentFiles[index];
    if (!file) return;
    const key = attachmentKey(file);
    const uploadedId = uploadedAttachmentIds.current.get(key);
    setAttachmentFiles((current) =>
      current.filter((_, itemIndex) => itemIndex !== index),
    );
    setCandidateTitles([]);
    if (uploadedId) {
      uploadedAttachmentIds.current.delete(key);
      void csrfToken().then((token) =>
        fetch(`/api/attachments/${uploadedId}`, {
          method: "DELETE",
          credentials: "include",
          headers: { "x-csrf-token": token },
        }).catch(() => undefined),
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!targets.length) return setError("请至少选择一个目标渠道");
    if (titleTooLong)
      return setError(
        `${titleLimitLabel}标题最多 ${titleLimit} 个字符，请缩短标题后再提交`,
      );
    setLoading(true);
    const form = new FormData(event.currentTarget);
    if (attachmentFiles.length > 10) {
      setLoading(false);
      return setError("单个任务最多上传 10 个附件");
    }
    if (
      contentType === "case" &&
      (targets.length !== 1 || targets[0] !== "xiaohongshu")
    ) {
      setLoading(false);
      return setError("项目案例模式 V1 目前仅支持小红书草稿渠道");
    }
    if (contentType === "case" && !attachmentFiles.length) {
      setLoading(false);
      return setError("项目案例必须上传 PRD、商务方案或验收材料");
    }
    if (
      contentType === "case" &&
      (!caseVisualTypes.includes("cover") || caseVisualTypes.length < 2)
    ) {
      setLoading(false);
      return setError("案例配图必须包含封面和至少一张项目图");
    }
    const sourceRefs = String(form.get("sourceRefs") ?? "")
      .split(/\n|，|,/)
      .map((value) => value.trim())
      .filter(Boolean);
    const secondaryTags = String(form.get("secondaryTags") ?? "")
      .split(/，|,/)
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      const attachmentIds = await uploadSelectedAttachments();
      const body = {
        operationId: crypto.randomUUID(),
        topic: form.get("topic"),
        title: String(form.get("title") ?? "").trim() || undefined,
        contentType,
        caseStatus: contentType === "case" ? form.get("caseStatus") : undefined,
        caseVisualTypes: contentType === "case" ? caseVisualTypes : undefined,
        readerMode: form.get("readerMode"),
        sourceRefs,
        attachmentIds,
        requireReviewBeforeDraft: true,
        targets,
        imageMode: "generated",
        includeGeekHome,
        primaryTag: String(form.get("primaryTag") ?? "").trim() || undefined,
        secondaryTags: secondaryTags.length ? secondaryTags : undefined,
        remarks: String(form.get("remarks") ?? "").trim() || undefined,
      };
      const token = await csrfToken();
      const response = await fetch("/api/content-jobs", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as {
        job?: { id: string };
        message?: string;
        error?: string;
      };
      if (!response.ok || !data.job)
        throw new Error(
          data.message ??
            (data.error === "INVALID_INPUT"
              ? "请检查填写内容"
              : "任务提交失败"),
        );
      router.push(`/tasks/${data.job.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务提交失败");
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="AI Content Studio"
        title="创建内容任务"
        description="填写核心需求后，系统将自动完成事实检索、品牌写作、配图、七渠道独立排版与草稿准备。"
      />
      <form onSubmit={submit} className="grid gap-5 xl:grid-cols-[1.5fr_.72fr]">
        <Card className="p-6 sm:p-8">
          <div className="mb-7 flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#fff1f2] text-[#e60012]">
              <Bot size={21} />
            </span>
            <div>
              <h2 className="font-bold">内容需求</h2>
              <p className="mt-1 text-xs text-[#85858e]">带 * 的项目为必填</p>
            </div>
          </div>
          <div className="grid gap-6">
            <Field
              label="内容类型 *"
              hint="项目案例会依据上传材料生成案例文章、封面和项目结构图"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    value: "general" as const,
                    title: "通识文章",
                    text: "行业观点、方法与趋势内容",
                  },
                  {
                    value: "case" as const,
                    title: "项目案例",
                    text: "PRD / 商务方案驱动的小红书案例",
                  },
                ].map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={contentType === item.value}
                    onClick={() => {
                      setContentType(item.value);
                      setCandidateTitles([]);
                      if (item.value === "case") {
                        setTargets(["xiaohongshu"]);
                      }
                    }}
                    className={`rounded-2xl border-2 p-4 text-left ${contentType === item.value ? "border-[#f6b8be] bg-[#fffafb]" : "border-[#ededf0] bg-white"}`}
                  >
                    <strong className="block text-sm">{item.title}</strong>
                    <span className="mt-1 block text-xs text-[#85858e]">
                      {item.text}
                    </span>
                  </button>
                ))}
              </div>
            </Field>
            {contentType === "case" && (
              <div className="grid gap-5 rounded-2xl border border-[#f6b8be] bg-[#fffafb] p-5">
                <Field
                  label="案例事实状态 *"
                  hint="方案型案例不会被写成已经上线或取得成效"
                >
                  <select
                    name="caseStatus"
                    className={inputClass}
                    defaultValue="proposal"
                  >
                    <option value="proposal">方案型案例 · 尚未确认交付</option>
                    <option value="delivered">
                      已交付案例 · 结果仍需验收或数据证据
                    </option>
                  </select>
                </Field>
                <Field
                  label="小红书案例配图 *"
                  hint="所有项目图均从附件提取，不由图片模型自由编写中文"
                >
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {(
                      [
                        ["cover", "案例封面"],
                        ["function", "功能全览图"],
                        ["flow", "业务流程图"],
                        ["roles", "角色协同图"],
                        ["architecture", "系统架构图"],
                      ] as const
                    ).map(([value, label]) => (
                      <label
                        key={value}
                        className="flex items-center gap-2 rounded-xl border border-[#ededf0] bg-white px-3 py-2.5 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={caseVisualTypes.includes(value)}
                          onChange={() =>
                            setCaseVisualTypes((current) =>
                              current.includes(value)
                                ? current.filter((item) => item !== value)
                                : [...current, value],
                            )
                          }
                          className="h-4 w-4 accent-[#e60012]"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </Field>
              </div>
            )}
            <Field
              label="内容主题 *"
              hint="请写清希望文章解决的问题、关注的趋势或核心观点"
            >
              <textarea
                required
                name="topic"
                value={topic}
                onChange={(event) => {
                  setTopic(event.currentTarget.value);
                  setCandidateTitles([]);
                }}
                minLength={2}
                maxLength={300}
                className={`${inputClass} min-h-28 resize-y py-3`}
                placeholder="例如：AI 智能体如何进入企业客户服务流程"
              />
            </Field>
            <Field
              label="参考资料附件"
              hint={
                contentType === "case"
                  ? "必填。请上传 PRD、商务方案或验收材料；如需写实手机封面，请同时上传 1–4 张真实产品截图（PNG/JPG），系统会优先高保真贴入手机屏幕"
                  : "支持 PDF、DOCX、TXT、Markdown、PNG、JPG；最多 10 个，单文件不超过 20 MiB"
              }
            >
              <label
                tabIndex={0}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (files.length) {
                    event.preventDefault();
                    acceptAttachmentFiles(files);
                  }
                }}
                className="focus-ring flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#d8d8dd] bg-[#fafafa] px-4 py-4 text-sm text-[#55555d] hover:border-[#f0a7ad] hover:bg-[#fffafb]"
              >
                <Paperclip size={17} className="text-[#e60012]" />
                <span className="min-w-0 flex-1">
                  {attachmentFiles.length
                    ? `已选择 ${attachmentFiles.length} 个附件`
                    : "选择文件，或在此处直接粘贴"}
                </span>
                <ClipboardPaste size={16} className="shrink-0 text-[#85858e]" />
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg"
                  className="sr-only"
                  onChange={(event) =>
                    acceptAttachmentFiles(
                      Array.from(event.currentTarget.files ?? []),
                    )
                  }
                />
              </label>
              {attachmentFiles.length > 0 && (
                <ul className="mt-3 grid gap-2">
                  {attachmentFiles.map((file, index) => (
                    <li
                      key={attachmentKey(file)}
                      className="flex items-center gap-3 rounded-xl border border-[#ededf0] bg-white px-3 py-2.5"
                    >
                      <Paperclip
                        size={14}
                        className="shrink-0 text-[#e60012]"
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#55555d]">
                        {file.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-[#9a9aa2]">
                        {(file.size / 1024 / 1024).toFixed(1)} MiB
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#85858e] hover:bg-[#fff1f2] hover:text-[#b90012]"
                        aria-label={`删除附件 ${file.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <Field
              label="参考资料链接"
              hint="每行一个 HTTPS 公开链接；候选标题和正文都会综合这些来源"
            >
              <div className="relative">
                <Link2
                  size={16}
                  className="absolute left-3.5 top-3.5 text-[#9a9aa2]"
                />
                <textarea
                  name="sourceRefs"
                  value={sourceRefs}
                  onChange={(event) => {
                    setSourceRefs(event.currentTarget.value);
                    setCandidateTitles([]);
                  }}
                  className={`${inputClass} min-h-24 resize-y py-3 pl-10`}
                  placeholder="https://example.com/source"
                />
              </div>
            </Field>
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="一级标签">
                <input
                  name="primaryTag"
                  value={primaryTag}
                  onChange={(event) => {
                    setPrimaryTag(event.currentTarget.value);
                    setCandidateTitles([]);
                  }}
                  className={inputClass}
                  placeholder="例如：AI 应用"
                />
              </Field>
              <Field label="二级标签">
                <input
                  name="secondaryTags"
                  value={secondaryTags}
                  onChange={(event) => {
                    setSecondaryTags(event.currentTarget.value);
                    setCandidateTitles([]);
                  }}
                  className={inputClass}
                  placeholder="使用逗号分隔，例如：智能体、数字化转型"
                />
              </Field>
            </div>
            <div>
              <Field
                label="文章标题"
                hint={
                  xiaohongshuSelected
                    ? "小红书标题最多 20 个字符；留空时由 AI 按渠道规则生成"
                    : wechatSelected
                      ? "公众号标题最多 32 个字符；留空时由 AI 按渠道规则生成"
                      : "留空则由 AI 自动生成；官网标题最多 120 个字符"
                }
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="text-xs text-[#85858e]">
                    可直接填写，也可让 AI 先给出 12 个候选标题
                  </span>
                  <button
                    type="button"
                    onClick={() => void generateTitles()}
                    disabled={generatingTitles || topic.trim().length < 2}
                    className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#f0b6bb] bg-[#fff7f8] px-3 py-1.5 text-xs font-semibold text-[#b90012] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <WandSparkles size={14} />
                    {generatingTitles ? "正在生成…" : "生成候选标题"}
                  </button>
                </div>
                {candidateTitles.length > 0 && (
                  <div className="mb-3 grid max-h-72 gap-2 overflow-y-auto rounded-xl border border-[#ededf0] bg-[#fafafa] p-2">
                    {candidateTitles.map((candidate, index) => (
                      <button
                        key={`${candidate}-${index}`}
                        type="button"
                        onClick={() => setTitle(candidate)}
                        className={`rounded-lg border px-3 py-2 text-left text-xs leading-5 transition ${title === candidate ? "border-[#e60012] bg-[#fff1f2] text-[#8f0010]" : "border-transparent bg-white text-[#55555d] hover:border-[#f0b6bb]"}`}
                      >
                        <span className="mr-2 font-bold text-[#e60012]">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        {candidate}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  name="title"
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  maxLength={120}
                  aria-invalid={titleTooLong}
                  aria-describedby="title-limit-hint"
                  className={`${inputClass} ${
                    titleTooLong
                      ? "border-[#e60012] focus:border-[#e60012]"
                      : ""
                  }`}
                  placeholder="留空则由 AI 自动生成"
                />
                <div
                  id="title-limit-hint"
                  className={`mt-2 flex items-start justify-between gap-3 text-xs ${
                    titleTooLong ? "text-[#b90012]" : "text-[#85858e]"
                  }`}
                >
                  <span>
                    {xiaohongshuSelected || wechatSelected
                      ? titleTooLong
                        ? `已超过${titleLimitLabel} ${titleLimit} 字限制，请缩短标题`
                        : `当前选择${titleLimitLabel}，标题需控制在 ${titleLimit} 字以内`
                      : "仅官网或其他渠道可使用更长标题"}
                  </span>
                  <span className="shrink-0">
                    {titleLength}/{titleLimit}
                  </span>
                </div>
              </Field>
            </div>
            <div className="grid items-stretch gap-5 md:grid-cols-2">
              <div className="flex min-w-0 flex-col">
                <label
                  htmlFor="reader-mode"
                  className="mb-2 text-sm font-semibold text-[#29292e]"
                >
                  读者模式 *
                </label>
                <div className="flex flex-1 flex-col rounded-2xl border border-[#dedee3] bg-white p-4">
                  <select
                    id="reader-mode"
                    name="readerMode"
                    className={inputClass}
                    value={readerMode}
                    onChange={(event) => {
                      setReaderMode(
                        event.currentTarget.value as "general" | "professional",
                      );
                      setCandidateTitles([]);
                    }}
                  >
                    <option value="general">普适模式 · 业务人员也能看懂</option>
                    <option value="professional">
                      专业模式 · 面向技术与决策人员
                    </option>
                  </select>
                  <p className="mt-3 flex-1 rounded-xl bg-[#f7f7f8] px-3 py-2.5 text-xs leading-5 text-[#73737c]">
                    {readerMode === "general"
                      ? "优先解释业务价值、实施路径与关键判断，减少不必要的技术术语。"
                      : "保留架构、技术边界与决策细节，仍以支持业务决策为目标。"}
                  </p>
                  <p className="mt-3 text-xs leading-5 text-[#85858e]">
                    当前选择会同步应用到候选标题和文章正文
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 flex-col">
                <p className="mb-2 text-sm font-semibold text-[#29292e]">
                  图片策略 *
                </p>
                <div className="flex flex-1 flex-col rounded-2xl border border-[#dedee3] bg-white p-4">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#fff1f2] text-[#e60012]">
                      <WandSparkles size={16} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-[#17171a]">
                        {contentType === "case"
                          ? "AI 案例图表 · 已启用"
                          : "AI 章节结构插图 · 默认启用"}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[#73737c]">
                        生成章节标题、关键要点与关系结构，不使用空泛的仿真实场景图。
                      </p>
                    </div>
                  </div>
                  {contentType === "general" && (
                    <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-[#f7f7f8] p-3">
                      <input
                        type="checkbox"
                        checked={includeGeekHome}
                        onChange={(event) =>
                          setIncludeGeekHome(event.currentTarget.checked)
                        }
                        className="mt-0.5 h-4 w-4 accent-[#e60012]"
                      />
                      <span>
                        <strong className="block text-xs text-[#333338]">
                          同时检索 GeekHome 真实素材
                        </strong>
                        <span className="mt-1 block text-xs leading-5 text-[#73737c]">
                          生成后进入复核，可多选并指定为正文配图、公众号封面或官网封面。
                        </span>
                      </span>
                    </label>
                  )}
                  <p className="mt-auto pt-3 text-xs leading-5 text-[#85858e]">
                    默认根据每个章节生成包含准确文字与结构关系的内容插图
                  </p>
                </div>
              </div>
            </div>
            <Field label="补充要求">
              <textarea
                name="remarks"
                maxLength={2000}
                value={remarks}
                onChange={(event) => {
                  remarksEditedRef.current = true;
                  setRemarks(event.currentTarget.value);
                  setDefaultRemarksFeedback("");
                  setCandidateTitles([]);
                }}
                className={`${inputClass} min-h-24 resize-y py-3`}
                placeholder="正在读取默认指令…"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#73737c]">
                <span>
                  {remarks.trim() === savedDefaultRemarks.trim()
                    ? "当前显示已保存的默认指令；本任务会使用输入框里的实际内容。"
                    : "当前内容尚未保存为默认指令；本任务仍会使用输入框里的实际内容。"}
                </span>
                <button
                  type="button"
                  onClick={() => void saveDefaultRemarks()}
                  disabled={
                    savingDefaultRemarks ||
                    !defaultRemarksLoaded ||
                    remarks.trim().length < 20
                  }
                  className="focus-ring inline-flex h-9 items-center justify-center rounded-lg border border-[#dedee3] bg-white px-3 font-semibold text-[#55555d] hover:border-[#e60012] hover:text-[#b90012] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {savingDefaultRemarks
                    ? "正在保存…"
                    : defaultRemarksLoaded
                      ? "保存为我的默认指令"
                      : "正在读取默认指令…"}
                </button>
              </div>
              {defaultRemarksFeedback && (
                <p
                  aria-live="polite"
                  className={`mt-2 text-xs ${defaultRemarksFeedback.startsWith("已保存") ? "text-[#187844]" : "text-[#b90012]"}`}
                >
                  {defaultRemarksFeedback}
                </p>
              )}
            </Field>
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                目标渠道 *<Badge tone="red">可选七渠道</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {[
                  {
                    target: "official_site" as const,
                    icon: Globe2,
                    title: "官网草稿箱",
                    text: "桌面端品牌排版",
                  },
                  {
                    target: "wechat" as const,
                    icon: MessageCircleMore,
                    title: "公众号草稿箱",
                    text: "移动端阅读排版",
                  },
                  {
                    target: "xiaohongshu" as const,
                    icon: BookOpen,
                    title: "小红书草稿",
                    text: "3:4 组图 · 扩展上传",
                  },
                  {
                    target: "zhihu" as const,
                    icon: BookOpen,
                    title: "知乎文章草稿",
                    text: "问答式长文 · 扩展保存",
                  },
                  {
                    target: "toutiao" as const,
                    icon: BookOpen,
                    title: "今日头条草稿",
                    text: "移动图文 · 扩展保存",
                  },
                  {
                    target: "baijiahao" as const,
                    icon: BookOpen,
                    title: "百家号草稿",
                    text: "搜索型图文 · 扩展保存",
                  },
                  {
                    target: "linkedin" as const,
                    icon: BookOpen,
                    title: "LinkedIn 文章",
                    text: "职业社交长文 · 扩展草稿/发布",
                  },
                ].map(({ target, icon: Icon, title, text }) => (
                  <label
                    key={target}
                    className={`flex items-center gap-3 rounded-2xl border-2 p-4 ${contentType === "case" && target !== "xiaohongshu" ? "cursor-not-allowed border-[#ededf0] bg-[#f8f8f9] opacity-55" : `cursor-pointer ${targets.includes(target) ? "border-[#f6b8be] bg-[#fffafb]" : "border-[#ededf0] bg-white"}`}`}
                  >
                    <input
                      type="checkbox"
                      checked={targets.includes(target)}
                      disabled={
                        contentType === "case" && target !== "xiaohongshu"
                      }
                      onChange={() => toggleTarget(target)}
                      className="h-4 w-4 accent-[#e60012]"
                    />
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-[#e60012] shadow-sm">
                      <Icon size={19} />
                    </span>
                    <span>
                      <strong className="block text-sm">{title}</strong>
                      <small className="text-[#85858e]">{text}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-xl border border-[#f6b8be] bg-[#fff1f2] px-4 py-3 text-sm text-[#b90012]"
              >
                {error}
              </div>
            )}
            <div className="flex flex-col items-start justify-between gap-4 border-t border-[#ededf0] pt-6 sm:flex-row sm:items-center">
              <p className="max-w-md text-xs leading-5 text-[#85858e]">
                官网和公众号通过服务端草稿接口写入；小红书、知乎、今日头条、百家号和 LinkedIn 由
                Chrome
                扩展使用当前已登录会话填写并保存草稿。内容生产始终先进入人工复核；浏览器渠道可在多账号发布中经过二次确认后正式发布。
              </p>
              <Button type="submit" disabled={loading}>
                <Send size={17} />
                {loading ? "正在提交…" : "开始生成内容"}
              </Button>
            </div>
          </div>
        </Card>
        <div className="space-y-5">
          <Card className="p-6">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-[#e60012]" />
              <h2 className="font-bold">自动执行流程</h2>
            </div>
            <ol className="mt-5 space-y-4">
              {[
                "建立事实证据清单",
                "生成极客跳动风格正文",
                "品牌约束去 AI 味",
                "GeekHome 选图或 AI 生图",
                "七渠道分别适配排版与内容长度",
                "独立质检并准备渠道产物",
              ].map((text, index) => (
                <li key={text} className="flex gap-3 text-sm">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#fff1f2] text-[11px] font-bold text-[#e60012]">
                    {index + 1}
                  </span>
                  <span className="pt-0.5 text-[#55555d]">{text}</span>
                </li>
              ))}
            </ol>
          </Card>
          <Card className="border-[#f6b8be] bg-[#fffafb] p-6">
            <div className="flex gap-3">
              <ImageIcon size={19} className="mt-0.5 shrink-0 text-[#e60012]" />
              <div>
                <h3 className="text-sm font-bold">先复核，再创建渠道草稿</h3>
                <p className="mt-2 text-xs leading-5 text-[#666a73]">
                  任务会先完成检索、写作、配图、排版和质检，再进入人工复核。修改文章与封面并点击通过后，才会写入对应渠道草稿箱；系统永不正式发布或群发。
                </p>
              </div>
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
