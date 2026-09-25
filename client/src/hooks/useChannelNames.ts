import { ChannelsResponseSchema } from '@videodeck/shared/schemas';
import { useEffect, useState } from 'react';
import { apiGet } from '../utils/apiClient';

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
    apiGet('/api/videos/channels', ChannelsResponseSchema, {
      signal: controller.signal,
      // The failure is swallowed below, but reading it still tells the health
      // store that the cluster is gone
      failureMessage: (_failure, status) => `channels fetch failed (HTTP ${status})`,
    })
      .then((parsed) => {
        setChannels(parsed.channels);
        setFolders(parsed.folders);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return { channels, folders };
}
