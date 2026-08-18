export function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}
