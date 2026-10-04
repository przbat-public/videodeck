import type { FolderListResponse, FolderStateResponse } from '@videodeck/shared/api';
import {
  EnqueueJobsResponseSchema,
  FolderListResponseSchema,
  FolderStateResponseSchema,
} from '@videodeck/shared/schemas';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';
import { apiGet, apiSend } from '../utils/apiClient';
import type { RepairMethod } from '../utils/libraryActions';
import { reconcileArchive, repairVideos, toastReconcileResult, toastRepairResult } from '../utils/libraryActions';
import { selectDownloadable, selectDownloaded, selectStale } from '../utils/videoSelection';
import { needsCompletion, skipReasonText } from '../utils/videoState';

/** Every queue action a console row can start */
export type ChannelAction =
  | 'download'
  | 'update'
  | 'update-stale'
  | 'cancel'
  | 'playlist'
  | 'repair'
  | 'repair-comments'
  | 'reconcile';

export interface UseChannelActionsOptions {
  /**
   * Called with the folder after an action changed the queue, so the console
   * can re-read it and pass the change down to the section it has open
   */
  onQueueChanged?: (folderPath: string) => void | Promise<void>;
  /** Called with the folder after a playlist fetch changed its `list.json` */
  onListChanged?: (folderPath: string) => void | Promise<void>;
}

export interface UseChannelActionsResult {
  /** Folder path to the action it is running, for the row's busy state */
  pending: Record<string, ChannelAction>;
  /** Start one action; handles its own toasts and never rejects */
  run: (folderPath: string, action: ChannelAction) => Promise<void>;
}

/** Read one channel's videos and download state, for a bulk action */
async function loadChannelVideos(folderPath: string): Promise<FolderListResponse> {
  return apiGet(`/api/folder/list?folderPath=${encodeURIComponent(folderPath)}`, FolderListResponseSchema, {
    cache: 'no-store',
    message: i18n.t('channelConsole.actions.listFailed'),
  });
}

/**
 * The incomplete videos of a channel, read through the state endpoint's own
 * filter. The answer decides who gets a repair job, and a video that is not on
 * disk never does: a repair runs with `--skip-download`, so handing it a video
 * the folder never downloaded would queue work that cannot do anything.
 */
async function loadIncompleteVideos(folderPath: string): Promise<FolderStateResponse> {
  return apiGet(
    `/api/folder/state?folderPath=${encodeURIComponent(folderPath)}&filter=incomplete`,
    FolderStateResponseSchema,
    { cache: 'no-store', failureMessage: (failure) => failure.message ?? i18n.t('videoState.loadError') },
  );
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

/**
 * The per-row actions of the channel console. Each one reads what it needs
 * from the folder's own endpoints and then talks to the existing queue API,
 * so the console needs no new server route and no SSE change. At most one
 * action runs per folder; the row disables itself meanwhile. A rejected
 * request throws, and `run` reports its message in one place.
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
      const selected = selectVideos(action, loaded);
      if (selected.length === 0) {
        toast.error(i18n.t('channelConsole.actions.nothingToDo'));
        return;
      }

      const type = action === 'download' ? 'download' : 'update';
      const result = await apiSend(
        'POST',
        '/api/folder/queue',
        EnqueueJobsResponseSchema,
        { folderPath, type, videos: selected.map((video) => ({ videoId: video.id })) },
        { failureMessage: (failure) => failure.message ?? i18n.t('toast.enqueueFailed') },
      );
      const target = i18n.t(type === 'update' ? 'toast.updateTarget' : 'toast.downloadTarget');
      toast.success(i18n.t('toast.addedToQueue', { count: result.jobs.length, target }));
      const [firstSkipped] = result.skipped;
      if (firstSkipped) {
        toast.error(
          i18n.t('toast.skipped', {
            count: result.skipped.length,
            reason: skipReasonText(firstSkipped.reason, i18n.t),
          }),
        );
      }
      await onQueueChanged?.(folderPath);
    },
    [onQueueChanged],
  );

  const cancelFolderQueue = useCallback(
    async (folderPath: string): Promise<void> => {
      await apiSend('DELETE', `/api/folder/queue?folderPath=${encodeURIComponent(folderPath)}`, null, undefined, {
        failureMessage: (failure) => failure.message ?? i18n.t('toast.enqueueFailed'),
      });
      toast.success(i18n.t('channelConsole.actions.cancelled'));
      await onQueueChanged?.(folderPath);
    },
    [onQueueChanged],
  );

  const downloadPlaylist = useCallback(
    async (folderPath: string): Promise<void> => {
      await apiSend(
        'POST',
        '/api/folder/download-playlist',
        null,
        { folderPath },
        {
          failureMessage: (failure) => failure.message ?? i18n.t('channelConsole.actions.listFailed'),
        },
      );
      toast.success(i18n.t('channelConsole.actions.playlistQueued'));
      await onListChanged?.(folderPath);
    },
    [onListChanged],
  );

  /** Queue the sidecars the downloaded videos of a channel are missing */
  const repairChannelGaps = useCallback(
    async (folderPath: string, method: RepairMethod): Promise<void> => {
      const state = await loadIncompleteVideos(folderPath);
      const videoIds = state.videos.filter((video) => needsCompletion(video.downloadState)).map((video) => video.id);
      if (videoIds.length === 0) {
        toast.error(i18n.t('channelConsole.actions.nothingToDo'));
        return;
      }
      const result = await repairVideos(folderPath, videoIds, method);
      toastRepairResult(result, method);
      await onQueueChanged?.(folderPath);
    },
    [onQueueChanged],
  );

  /** Rewrite `archive.txt` from the disk, and say what that changed */
  const reconcileChannelArchive = useCallback(
    async (folderPath: string): Promise<void> => {
      const result = await reconcileArchive(folderPath);
      toastReconcileResult(result);
      await onQueueChanged?.(folderPath);
    },
    [onQueueChanged],
  );

  /** Which of the row's actions runs, and with what */
  const runAction = useCallback(
    async (folderPath: string, action: ChannelAction): Promise<void> => {
      switch (action) {
        case 'cancel':
          return cancelFolderQueue(folderPath);
        case 'playlist':
          return downloadPlaylist(folderPath);
        case 'repair':
          return repairChannelGaps(folderPath, 'sidecars');
        case 'repair-comments':
          return repairChannelGaps(folderPath, 'comments');
        case 'reconcile':
          return reconcileChannelArchive(folderPath);
        default:
          return enqueueSelection(folderPath, action);
      }
    },
    [cancelFolderQueue, downloadPlaylist, enqueueSelection, reconcileChannelArchive, repairChannelGaps],
  );

  const run = useCallback(
    async (folderPath: string, action: ChannelAction): Promise<void> => {
      setFolderPending(folderPath, action);
      try {
        await runAction(folderPath, action);
      } catch (err) {
        // A rejected request, a network failure or a bad body: reported once,
        // with the message the server sent when there was one
        toast.error(err instanceof Error ? err.message : i18n.t('errors.occurred'));
      } finally {
        setFolderPending(folderPath, null);
      }
    },
    [runAction, setFolderPending],
  );

  return { pending, run };
}
