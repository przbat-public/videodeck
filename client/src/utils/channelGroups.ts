/**
 * The channel filter offers one section per category, because a library with
 * a folder of single downloads holds hundreds of one-off channel names and a
 * flat list hides the channels that belong to a folder.
 */

export interface ChannelGroup {
  /** The category, or '' for the channels whose folder declares none */
  category: string;
  channels: string[];
}

/** Uncategorized channels come after every named category, never between two */
const rank = (category: string): number => (category === '' ? 1 : 0);

/**
 * The channels sorted into their folder's category. Both levels are sorted
 * here rather than trusted from the caller, so a channel appended from the
 * URL lands in its place instead of at the end of a section.
 */
export function groupChannelsByCategory(
  channels: readonly string[],
  channelCategories: Readonly<Record<string, string>>,
): ChannelGroup[] {
  const byCategory = new Map<string, string[]>();
  for (const channel of channels) {
    const category = channelCategories[channel] ?? '';
    const group = byCategory.get(category);
    if (group === undefined) {
      byCategory.set(category, [channel]);
    } else {
      group.push(channel);
    }
  }

  return [...byCategory.entries()]
    .map(([category, names]) => ({ category, channels: [...names].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
}
