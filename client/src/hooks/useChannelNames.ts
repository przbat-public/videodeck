import { ChannelsResponseSchema } from '@videodeck/shared/schemas';
import { useEffect, useState } from 'react';

interface UseChannelNamesResult {
  /** Distinct channel names from Elasticsearch, for the channel filter */
  channels: string[];
}

/**
 * GET /api/videos/channels — feeds the channel select in the search bar.
 * A failure silently yields an empty list: the filter hides until the list
 * arrives.
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
