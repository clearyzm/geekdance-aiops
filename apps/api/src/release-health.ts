import type { WorkerRuntimeSnapshot } from "@geekdance/shared";

export function workerReleaseMatches(
  apiRelease: string,
  runtime: WorkerRuntimeSnapshot | null,
) {
  return Boolean(runtime && runtime.release === apiRelease);
}
