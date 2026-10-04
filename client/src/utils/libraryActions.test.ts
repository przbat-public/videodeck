import type { ArchiveReconcileResponse, EnqueueJobsResponse } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import type { FetchMock } from '../test/fetchMock';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { toast } from '../test/toastMock';
import { reconcileArchive, repairVideos, toastReconcileResult, toastRepairResult } from './libraryActions';

const fetchMock: FetchMock = installFetchMock();

const FOLDER = '/videos/kanal-a';

const job = (videoId: string): EnqueueJobsResponse['jobs'][number] => ({
  id: `job-${videoId}`,
  folderPath: FOLDER,
  videoId,
  videoUrl: `https://youtu.be/${videoId}`,
  type: 'repair',
  status: 'queued',
  log: [],
  logLineCount: 0,
  createdAt: '2026-09-19T10:00:00.000Z',
});

describe('repairVideos', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('posts the videos to the repair endpoint and reads the queue answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [job('a')], skipped: [] }, 202));

    const result = await repairVideos(FOLDER, ['a'], 'sidecars');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/folder/repair');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      folderPath: FOLDER,
      method: 'sidecars',
      videos: [{ videoId: 'a' }],
    });
    expect(result.jobs).toHaveLength(1);
  });

  it('asks for the comment refresh when the caller says so', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [], skipped: [] }, 202));

    await repairVideos(FOLDER, ['a'], 'comments');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).method).toBe('comments');
  });

  it('reports the message the server refused with', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'videos must be a non-empty array' }, 400));

    await expect(repairVideos(FOLDER, [], 'sidecars')).rejects.toThrow('videos must be a non-empty array');
  });

  it('falls back to its own wording when the refusal carries no message', async () => {
    // A body the error contract cannot parse (a proxy's HTML, say) leaves the
    // failure with nothing to show, so the caller gets a sentence it can act on.
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ html: 'bad gateway' }) });

    await expect(repairVideos(FOLDER, ['aaaaaaaaaaa'], 'sidecars')).rejects.toThrow(i18n.t('toast.enqueueFailed'));
  });
});

describe('toastRepairResult', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('reports how many videos were queued', () => {
    toastRepairResult({ jobs: [job('a'), job('b')], skipped: [] }, 'sidecars');

    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.repairQueued', { count: 2 }));
  });

  it('names the comment refresh as what it queued', () => {
    toastRepairResult({ jobs: [job('a')], skipped: [] }, 'comments');

    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.commentsQueued', { count: 1 }));
  });

  it('translates the reason the server skipped a video', () => {
    toastRepairResult({ jobs: [], skipped: [{ videoId: 'b', reason: 'not downloaded' }] }, 'sidecars');

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      i18n.t('toast.skipped', { count: 1, reason: i18n.t('skipReason.notDownloaded') }),
    );
  });
});

describe('reconcileArchive', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('rebuilds archive.txt from the disk and reads what changed', async () => {
    const body: ArchiveReconcileResponse = {
      added: ['a'],
      removed: ['b'],
      unchanged: 3,
      drift: { missingFromArchive: [], missingFromDisk: [] },
    };
    fetchMock.mockResolvedValue(jsonResponse(body));

    const result = await reconcileArchive(FOLDER);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/folder/archive/reconcile');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ folderPath: FOLDER, method: 'rebuild' });
    expect(result).toEqual(body);
  });

  it('falls back to its own wording when the reconcile refusal carries none', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ html: 'bad gateway' }) });

    await expect(reconcileArchive(FOLDER)).rejects.toThrow(i18n.t('toast.enqueueFailed'));
  });

  it('reports the refusal of an unmounted drive', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'refusing to touch archive.txt' }, 409));

    await expect(reconcileArchive(FOLDER)).rejects.toThrow('refusing to touch archive.txt');
  });
});

describe('toastReconcileResult', () => {
  it('says what the reconcile changed', () => {
    toastReconcileResult({
      added: ['a', 'b'],
      removed: ['c'],
      unchanged: 4,
      drift: { missingFromArchive: [], missingFromDisk: [] },
    });

    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.archiveReconciled', { added: 2, removed: 1 }));
  });

  it('says so when the archive already matched the disk', () => {
    toastReconcileResult({
      added: [],
      removed: [],
      unchanged: 12,
      drift: { missingFromArchive: [], missingFromDisk: [] },
    });

    expect(toast.success).toHaveBeenCalledWith(i18n.t('toast.archiveAligned', { unchanged: 12 }));
  });
});
