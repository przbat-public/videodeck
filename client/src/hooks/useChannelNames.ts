import { ChannelsResponseSchema } from '@videodeck/shared/schemas';
import { useEffect, useState } from 'react';

interface UseChannelNamesResult {
  /** Distinct channel names from Elasticsearch, for the channel filter */
  channels: string[];
  /** Folder path to channel name, for the console's "search in this channel" */
  folders: Record<string, string>;
}

/**
 * GET /api/videos/channels — feeds the channel select in the search bar and
 * the console's per-channel search link. A failure silently yields empty
 * values: the filter hides until the list arrives, and the link hides with it.
 */
export function useChannelNames(): UseChannelNamesResult {
  const [channels, setChannels] = useState<string[]>([]);
  const [folders, setFolders] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/videos/channels', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`channels fetch failed (HTTP ${response.status})`);
        }
        return response.json();
      })
      .then((data: unknown) => {
        const parsed = ChannelsResponseSchema.parse(data);
        setChannels(parsed.channels);
        setFolders(parsed.folders);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return { channels, folders };
}
