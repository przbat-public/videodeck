import type { FolderListResponse } from '@videodeck/shared/api';
import { ApiErrorSchema, EnqueueJobsResponseSchema, FolderListResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import { selectDownloadable, selectDownloaded, selectStale } from '../utils/videoSelection';

/** Every queue action a console row can start */
export type ChannelAction = 'download' | 'update' | 'update-stale' | 'cancel' | 'playlist';

export interface UseChannelActionsOptions {
  /** Called after an action changed the queue, so the console can re-read it */
  onQueueChanged?: () => void | Promise<void>;
  /** Called after a playlist fetch changed the channel's `list.json` */
  onListChanged?: () => void | Promise<void>;
}

export interface UseChannelActionsResult {
  /** Folder path to the action it is running, for the row's busy state */
  pending: Record<string, ChannelAction>;
  /** Start one action; handles its own toasts and never rejects */
  run: (folderPath: string, action: ChannelAction) => Promise<void>;
}

/** Read one channel's videos and download state, for a bulk action */
async function loadChannelVideos(folderPath: string): Promise<FolderListResponse | null> {
  const response = await fetch(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`, { cache: 'no-store' });
  if (!response.ok) {
    toast.error(i18n.t('channelConsole.actions.listFailed'));
    return null;
  }
  return FolderListResponseSchema.parse(await response.json());
}

/** The videos one bulk action works on, read from the channel's own list */
function selectVideos(
  action: 'download' | 'update' | 'update-stale',
  list: FolderListResponse,
): FolderListResponse['videos'] {
  if (action === 'download') {
    return selectDownloadable(list.videos, list.downloadStatuses);
  }
  if (action === 'update') {
    return selectDownloaded(list.videos, list.downloadStatuses);
  }
  return selectStale(list.videos, list.downloadStatuses, list.lastUpdatedDates);
}

/** Server-supplied reason for a rejected request, or the fallback key */
async function failureMessage(
  response: Response,
  fallbackKey: 'toast.enqueueFailed' | 'channelConsole.actions.listFailed',
): Promise<string> {
  const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? (parsed.data.message ?? parsed.data.error) : i18n.t(fallbackKey);
}

/**
 * The per-row actions of the channel console. Each one reads what it needs
 * from the folder's own endpoints and then talks to the existing queue API,
 * so the console needs no new server route and no SSE change. At most one
 * action runs per folder; the row disables itself meanwhile.
 */
export function useChannelActions(options: UseChannelActionsOptions = {}): UseChannelActionsResult {
  const { onQueueChanged, onListChanged } = options;
  const [pending, setPending] = useState<Record<string, ChannelAction>>({});

  const setFolderPending = useCallback((folderPath: string, action: ChannelAction | null): void => {
    setPending((previous) => {
      const next = { ...previous };
      if (action === null) {
        delete next[folderPath];
      } else {
        next[folderPath] = action;
      }
      return next;
    });
  }, []);

  const enqueueSelection = useCallback(
    async (folderPath: string, action: 'download' | 'update' | 'update-stale'): Promise<void> => {
      const loaded = await loadChannelVideos(folderPath);
      if (loaded === null) {
        return;
      }
      const selected = selectVideos(action, loaded);
      if (selected.length === 0) {
        toast.error(i18n.t('channelConsole.actions.nothingToDo'));
        return;
      }

      const type = action === 'download' ? 'download' : 'update';
      const response = await fetch('/api/folder/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, type, videos: selected.map((video) => ({ videoId: video.id })) }),
      });
      if (!response.ok) {
        toast.error(await failureMessage(response, 'toast.enqueueFailed'));
        return;
      }
      const result = EnqueueJobsResponseSchema.parse(await response.json());
      const target = i18n.t(type === 'update' ? 'toast.updateTarget' : 'toast.downloadTarget');
      toast.success(i18n.t('toast.addedToQueue', { count: result.jobs.length, target }));
      const [firstSkipped] = result.skipped;
      if (firstSkipped) {
        toast.error(i18n.t('toast.skipped', { count: result.skipped.length, reason: firstSkipped.reason }));
      }
      await onQueueChanged?.();
    },
    [onQueueChanged],
  );

  const cancelFolderQueue = useCallback(
    async (folderPath: string): Promise<void> => {
      const response = await fetch(`/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        toast.error(await failureMessage(response, 'toast.enqueueFailed'));
        return;
      }
      toast.success(i18n.t('channelConsole.actions.cancelled'));
      await onQueueChanged?.();
    },
    [onQueueChanged],
  );

  const downloadPlaylist = useCallback(
    async (folderPath: string): Promise<void> => {
      const response = await fetch('/api/folder/download-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });
      if (!response.ok) {
        toast.error(await failureMessage(response, 'channelConsole.actions.listFailed'));
        return;
      }
      toast.success(i18n.t('channelConsole.actions.playlistQueued'));
      await onListChanged?.();
    },
    [onListChanged],
  );

  const run = useCallback(
    async (folderPath: string, action: ChannelAction): Promise<void> => {
      setFolderPending(folderPath, action);
      try {
        if (action === 'cancel') {
          await cancelFolderQueue(folderPath);
        } else if (action === 'playlist') {
          await downloadPlaylist(folderPath);
        } else {
          await enqueueSelection(folderPath, action);
        }
      } catch (err) {
        // A throw here is a network or parse failure: report it once, in the
        // same shape as the server-side failures above.
        toast.error(err instanceof Error ? err.message : i18n.t('errors.occurred'));
      } finally {
        setFolderPending(folderPath, null);
      }
    },
    [cancelFolderQueue, downloadPlaylist, enqueueSelection, setFolderPending],
  );

  return { pending, run };
}
