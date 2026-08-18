export type ReviewCategory = "content_quality" | "delivery_uncertain";
export type ReviewDecision =
  | "approve_content"
  | "reject_content"
  | "confirm_drafted"
  | "confirm_absent_retry";

export function reviewCategory(row: Record<string, any>): ReviewCategory {
  const artifact = row.result?.channelArtifacts?.[row.target];
  return row.error_code === "GEEKHOME_SELECTION_REQUIRED" ||
    row.error_code === "CONTENT_REVIEW_REQUIRED" ||
    row.result?.contentStatus === "blocked" ||
    artifact?.status === "manual_review"
    ? "content_quality"
    : "delivery_uncertain";
}

export function reviewReason(row: Record<string, any>) {
  const artifact = row.result?.channelArtifacts?.[row.target];
  const reasonCode = row.error_code || row.xhs_error_code;
  const deliveryReasons: Record<string, string> = {
    GEEKHOME_SELECTION_REQUIRED:
      "AI 章节结构插图已生成，请在智能配图中选择可选 GeekHome 素材，并指定正文或渠道封面用途。",
    UPLOAD_CLAIM_EXPIRED:
      "扩展上传会话已过期，草稿是否保存无法确认，请先到对应平台创作中心核对。",
    OFFICIAL_PUBLISH_INTERRUPTED:
      "官网草稿写入过程被中断，结果无法确认，请先到官网后台核对。",
    WECHAT_PUBLISH_INTERRUPTED:
      "公众号草稿写入过程被中断，结果无法确认，请先到公众号后台核对。",
  };
  return (
    artifact?.reason ||
    row.result?.manualReviewReason ||
    deliveryReasons[reasonCode] ||
    reasonCode ||
    "该渠道需要人工确认后才能继续"
  );
}

export function reviewDecisionAllowed(
  category: ReviewCategory,
  decision: ReviewDecision,
) {
  return category === "content_quality"
    ? ["approve_content", "reject_content"].includes(decision)
    : ["confirm_drafted", "confirm_absent_retry"].includes(decision);
}

export function reviewedArtifactIsUsable(result: any, target: string) {
  const artifact = result?.channelArtifacts?.[target];
  if (!artifact) return false;
  if (target === "xiaohongshu")
    return Boolean(artifact.note?.title?.trim() && artifact.note?.body?.trim());
  return Boolean(artifact.article?.title?.trim() && artifact.html?.trim());
}

export function reviewDecisionPlan(decision: ReviewDecision) {
  return {
    queuesReviewedTarget:
      decision === "approve_content" || decision === "confirm_absent_retry",
    performsImmediateExternalWrite: false,
    requiresChannelAbsenceConfirmation: decision === "confirm_absent_retry",
    updatesInternalStatusOnly: decision === "confirm_drafted",
  };
}
