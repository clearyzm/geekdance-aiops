export type DeliveryBatchStatus =
  | "queued"
  | "running"
  | "partial"
  | "completed"
  | "failed"
  | "ambiguous"
  | "manual_review";

export function summarizeDeliveryItems(states: string[]): DeliveryBatchStatus {
  const success = states.filter((state) =>
    ["drafted", "published"].includes(state),
  ).length;
  const active = states.some((state) =>
    ["waiting_for_extension", "uploading"].includes(state),
  );
  const ambiguous = states.some((state) => state === "ambiguous");
  const manual = states.some((state) =>
    ["filled", "manual_review"].includes(state),
  );
  const failed = states.filter((state) =>
    ["failed", "cancelled"].includes(state),
  ).length;
  if (active)
    return success || failed || ambiguous || manual ? "running" : "queued";
  if (ambiguous) return "ambiguous";
  if (manual) return "manual_review";
  if (success === states.length) return "completed";
  if (success > 0) return "partial";
  return "failed";
}

export function formalPublishConfirmed(input: {
  reviewConfirmed?: boolean;
  confirmTitle?: string;
  reviewedTitle: string;
}) {
  return (
    input.reviewConfirmed === true && input.confirmTitle === input.reviewedTitle
  );
}

export function deliveryResultMatchesMode(mode: string, status: string) {
  if (mode === "draft" && status === "published") return false;
  if (mode === "publish" && status === "drafted") return false;
  return true;
}
