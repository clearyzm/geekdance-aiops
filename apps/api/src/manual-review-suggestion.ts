export type ReviewMaterialCandidate = {
  id?: string;
  url?: string;
  title?: string;
};

/**
 * GeekHome may refresh an OSS signed URL between displaying a candidate and
 * approving the review. Prefer the stable material id, then fall back to an
 * exact URL for legacy candidates that do not expose an id.
 */
export function resolveReviewMaterialCandidate<
  T extends ReviewMaterialCandidate,
>(candidates: T[], choice: { materialId: string; url: string }) {
  return (
    candidates.find(
      (candidate) =>
        typeof candidate.id === "string" && candidate.id === choice.materialId,
    ) ?? candidates.find((candidate) => candidate.url === choice.url)
  );
}
