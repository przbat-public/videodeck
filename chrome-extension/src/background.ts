import type { DownloadVideoEvent } from '@videodeck/shared/api';
import type { ActiveDownloadSummary, RuntimeMessage } from './lib/messages';
import { feedSseBuffer, parseSseEvent } from './lib/sse';

/**
 * Background service worker: owns the list of active downloads and streams
 * yt-dlp output from the server's SSE endpoint to the popup.
 */

interface ActiveDownload {
  videoUrl: string;
  videoTitle: string;
  progress: number;
  status: 'starting' | 'downloading';
  startTime: number;
}

/** Events pushed from the background worker to the popup */
type BackgroundEvent =
  | { action: 'downloadStart'; downloadId: number; videoTitle?: string }
  | { action: 'downloadProgress'; downloadId: number; progress?: number; message?: string }
  | { action: 'downloadComplete'; downloadId: number; message?: string }
  | { action: 'downloadError'; downloadId: number; error?: string }
  | { action: 'downloadCancelled'; downloadId: number };

const activeDownloads = new Map<number, ActiveDownload>();
let downloadIdCounter = 0;

/** chrome.storage.session key holding the active-download snapshot */
const STORAGE_KEY = 'activeDownloads';

/**
 * Persist the active downloads so a killed service worker can be honest
 * about what it lost. chrome.storage.session survives worker restarts but
 * not browser restarts — exactly the window we care about.
 */
function persistActiveDownloads(): void {
  const snapshot = Array.from(activeDownloads.entries()).map(([downloadId, download]) => ({
    downloadId,
    videoUrl: download.videoUrl,
    videoTitle: download.videoTitle,
    progress: download.progress,
    status: download.status,
    startTime: download.startTime,
  }));
  void chrome.storage.session.set({ [STORAGE_KEY]: snapshot });
}

/**
 * After a service-worker restart the downloads keep running server-side but
 * their streams are gone: report each one as errored (never as succeeded)
 * and clear the snapshot. The server-side job is unaffected.
 */
function restoreActiveDownloadsOnStartup(): void {
  void chrome.storage.session.get([STORAGE_KEY]).then((stored) => {
    const snapshot = (stored as Record<string, unknown>)[STORAGE_KEY];
    if (!Array.isArray(snapshot)) {
      return;
    }
    for (const entry of snapshot as Array<Record<string, unknown>>) {
      const downloadId = typeof entry.downloadId === 'number' ? entry.downloadId : undefined;
      if (downloadId !== undefined) {
        notifyDownloadUpdate(downloadId, 'downloadError', { error: chrome.i18n.getMessage('workerRestarted') });
      }
    }
    void chrome.storage.session.remove(STORAGE_KEY);
  });
}

restoreActiveDownloadsOnStartup();
chrome.runtime.onStartup.addListener(restoreActiveDownloadsOnStartup);

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  // Only messages from this extension's own contexts (content script, popup,
  // options) are trusted: any other installed extension could otherwise
  // drive downloads or read the active-download list.
  if (sender.id !== undefined && sender.id !== chrome.runtime.id) {
    return false;
  }
  if (message.action === 'downloadVideo') {
    const downloadId = ++downloadIdCounter;
    const videoTitle = message.videoTitle || chrome.i18n.getMessage('videoTitleFallback');

    activeDownloads.set(downloadId, {
      videoUrl: message.videoUrl,
      videoTitle,
      progress: 0,
      status: 'starting',
      startTime: Date.now(),
    });
    persistActiveDownloads();

    updateBadge();
    notifyDownloadUpdate(downloadId, 'downloadStart', { videoTitle });

    downloadVideo(downloadId, message.videoUrl, message.serverUrl, message.folderPath, message.apiToken).catch(
      (error: unknown) => {
        activeDownloads.delete(downloadId);
        persistActiveDownloads();
        updateBadge();
        notifyDownloadUpdate(downloadId, 'downloadError', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return true; // keep the message channel open for the async work
  }

  if (message.action === 'getActiveDownloads') {
    sendResponse({ downloads: listDownloads() });
    return true;
  }

  if (message.action === 'cancelDownload') {
    // Cancelling the SSE stream client-side only stops the UI: the server
    // queue keeps downloading (the extension docs say so), so we just drop
    // the local entry.
    if (activeDownloads.has(message.downloadId)) {
      activeDownloads.delete(message.downloadId);
      persistActiveDownloads();
      updateBadge();
      notifyDownloadUpdate(message.downloadId, 'downloadCancelled', {});
    }
    return true;
  }

  return false;
});

function listDownloads(): ActiveDownloadSummary[] {
  return Array.from(activeDownloads.entries()).map(([id, download]) => ({
    id,
    ...download,
  }));
}

async function downloadVideo(
  downloadId: number,
  videoUrl: string,
  serverUrl: string,
  folderPath: string,
  apiToken?: string,
): Promise<void> {
  const apiUrl = `${serverUrl}/api/folder/download-video`;

  if (!activeDownloads.has(downloadId)) {
    return;
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
      body: JSON.stringify({ folderPath, videoUrl }),
    });

    if (!response.ok) {
      throw new Error((await readApiError(response)) ?? `HTTP ${response.status}`);
    }

    const download = activeDownloads.get(downloadId);
    if (download) {
      download.status = 'downloading';
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response has no body');
    }

    await streamDownload(downloadId, reader);
  } catch (error) {
    activeDownloads.delete(downloadId);
    updateBadge();
    notifyDownloadUpdate(downloadId, 'downloadError', {
      error: error instanceof Error ? error.message : chrome.i18n.getMessage('unknownError'),
    });
    throw error;
  }
}

/** Reads the SSE stream and reacts to each event; returns when it ends or is cancelled. */
async function streamDownload(downloadId: number, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    // Check if the download was cancelled
    if (!activeDownloads.has(downloadId)) {
      await reader.cancel();
      return;
    }

    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const { events, buffer: rest } = feedSseBuffer(buffer, decoder.decode(value, { stream: true }));
    buffer = rest;

    for (const raw of events) {
      const event = parseSseEvent(raw);
      if (event !== null && handleSseEvent(downloadId, event)) {
        return;
      }
    }
  }

  // The stream ended without a downloadComplete event: the server crashed,
  // the network dropped or the service worker was killed — the download may
  // still be running server-side, so reporting success would be a lie.
  activeDownloads.delete(downloadId);
  persistActiveDownloads();
  updateBadge();
  notifyDownloadUpdate(downloadId, 'downloadError', {
    error: chrome.i18n.getMessage('streamEndedUnexpectedly'),
  });
}

/** Reacts to one SSE event; returns true when the stream is finished. */
function handleSseEvent(downloadId: number, event: DownloadVideoEvent): boolean {
  switch (event.type) {
    case 'downloadStart':
      notifyDownloadUpdate(downloadId, 'downloadProgress', {
        progress: 0,
        message: event.videoTitle || chrome.i18n.getMessage('startingDownload'),
      });
      return false;
    case 'downloadProgress': {
      // The server sends the parsed percentage as a field; the message is
      // for display only, never for parsing.
      const progress = event.progress;
      if (progress !== undefined) {
        const download = activeDownloads.get(downloadId);
        if (download) {
          download.progress = progress;
          persistActiveDownloads();
        }
      }
      notifyDownloadUpdate(downloadId, 'downloadProgress', {
        ...(progress !== undefined ? { progress } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
      });
      return false;
    }
    case 'downloadComplete':
      activeDownloads.delete(downloadId);
      persistActiveDownloads();
      updateBadge();
      notifyDownloadUpdate(downloadId, 'downloadComplete', {
        message: event.message || chrome.i18n.getMessage('downloadFinished'),
      });
      return true;
    case 'downloadError':
      activeDownloads.delete(downloadId);
      persistActiveDownloads();
      updateBadge();
      throw new Error(event.error || chrome.i18n.getMessage('downloadFailed'));
  }
}

/** The `error`/`message` field of an ApiError body, when present */
async function readApiError(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  for (const key of ['error', 'message'] as const) {
    if (typeof record[key] === 'string' && record[key].length > 0) {
      return record[key];
    }
  }
  return null;
}

function notifyDownloadUpdate<K extends BackgroundEvent['action']>(
  downloadId: number,
  action: K,
  data: Omit<Extract<BackgroundEvent, { action: K }>, 'action' | 'downloadId'>,
): void {
  chrome.runtime.sendMessage({ action, downloadId, ...data }).catch(() => {
    // Ignore errors when no listener is around (popup might be closed)
  });
}

function updateBadge(): void {
  const count = activeDownloads.size;
  if (count > 0) {
    void chrome.action.setBadgeText({ text: count.toString() });
    void chrome.action.setBadgeBackgroundColor({ color: '#1976d2' });
  } else {
    void chrome.action.setBadgeText({ text: '' });
  }
}
