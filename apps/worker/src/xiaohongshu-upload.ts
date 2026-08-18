export type XiaohongshuUploadImage = {
  id: string | null;
  url: string;
  title: string;
};

type ArtifactAsset = {
  selected?: {
    id?: string | null;
    url?: string | null;
    title?: string | null;
  } | null;
};

type GeneratedAsset = {
  id: string;
  url: string;
  title?: string | null;
};

/**
 * Build the exact image list handed to the Xiaohongshu extension. Reviewed
 * artifact images remain authoritative. Generated candidates are only used
 * when a review removed every image, because an image-note cannot enter the
 * Xiaohongshu editor without at least one image.
 */
export function resolveXiaohongshuUploadImages(
  artifactAssets: ArtifactAsset[],
  generatedAssets: GeneratedAsset[],
  limit = 8,
): XiaohongshuUploadImage[] {
  const reviewed = artifactAssets.flatMap((asset) =>
    typeof asset.selected?.url === "string" && asset.selected.url
      ? [
          {
            id: asset.selected.id ?? null,
            url: asset.selected.url,
            title: asset.selected.title?.trim() || "小红书配图",
          },
        ]
      : [],
  );
  const source = reviewed.length
    ? reviewed
    : generatedAssets.map((asset) => ({
        id: asset.id,
        url: asset.url,
        title: asset.title?.trim() || "AI 章节插图",
      }));
  return source
    .filter(
      (image, index, images) =>
        images.findIndex((candidate) => candidate.url === image.url) === index,
    )
    .slice(0, limit);
}
