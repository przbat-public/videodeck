import { ChannelsResponseSchema } from '@shared/schemas';
import { useEffect, useState } from 'react';

interface UseChannelNamesResult {
  /** Distinct channel names from Elasticsearch, for the filter suggestions */
  channels: string[];
}

/**
 * GET /api/videos/channels — feeds the datalist of the channel filter.
 * A failure silently yields an empty list: the filter stays usable without
 * suggestions (the input itself still filters).
 */
export function useChannelNames(): UseChannelNamesResult {
  const [channels, setChannels] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/videos/channels', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`channels fetch failed (HTTP ${response.status})`);
        }
        return response.json();
      })
      .then((data: unknown) => setChannels(ChannelsResponseSchema.parse(data).channels))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return { channels };
}
