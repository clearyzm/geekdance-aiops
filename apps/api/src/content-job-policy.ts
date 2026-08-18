import type { JobStatus } from "@geekdance/shared";

export const contentGenerationActiveStatuses: JobStatus[] = [
  "queued",
  "researching",
  "writing",
  "formatting",
  "publishing",
];

export const cancellableJobStatuses: JobStatus[] = [
  ...contentGenerationActiveStatuses,
  "awaiting_upload",
];

export const cancellableTargetStatuses = [
  "queued",
  "prepared",
  "waiting_for_uploader",
] as const;

export const cancellationUnsafeTargetStatuses = [
  "publishing",
  "uploading",
] as const;

export function summarizeContentJobTargets(statuses: string[]): {
  status: JobStatus;
  message: string;
} {
  const drafted = statuses.filter((status) => status === "drafted").length;
  const cancelled = statuses.filter((status) => status === "cancelled").length;
  const awaiting = statuses.some((status) =>
    ["waiting_for_uploader", "uploading", "prepared"].includes(status),
  );
  const awaitingManualSave = statuses.some((status) => status === "filled");
  const status: JobStatus =
    cancelled === statuses.length
      ? "cancelled"
      : drafted === statuses.length
        ? "drafted"
        : awaitingManualSave
          ? "awaiting_manual_save"
          : awaiting
            ? "awaiting_upload"
            : drafted > 0
              ? "partial"
              : statuses.some((item) =>
                    ["ambiguous", "manual_review"].includes(item),
                  )
                ? "manual_review"
                : "failed";
  const message =
    status === "cancelled"
      ? "任务已取消"
      : status === "drafted"
        ? "所选渠道草稿已创建"
        : status === "awaiting_manual_save"
          ? "平台内容已填写完成，请在对应创作页面检查并人工保存草稿"
          : status === "awaiting_upload"
            ? "等待 Chrome 扩展将内容保存到所选平台草稿箱"
            : status === "partial" && cancelled > 0
              ? "已创建的渠道草稿保持不变，其余渠道任务已取消"
              : status === "partial"
                ? "部分渠道草稿已创建"
                : status === "manual_review"
                  ? "平台草稿保存结果需要人工复核，系统不会自动重试"
                  : "草稿创建失败";
  return { status, message };
}
