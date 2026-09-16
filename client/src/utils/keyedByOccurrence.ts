/**
 * Stable keys for a list of strings that can repeat verbatim (split text
 * fragments, append-only log lines). The key is the content plus its
 * occurrence count: stable across re-renders and unique among siblings.
 */
export const keyedByOccurrence = (items: string[]): Array<{ value: string; key: string }> => {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { value: item, key: occurrence === 0 ? item : `${item}-${occurrence}` };
  });
};
