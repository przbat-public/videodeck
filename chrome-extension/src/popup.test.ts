// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byId } from './lib/dom';
import type { ActiveDownloadSummary, PopupConfig, RuntimeMessage } from './lib/messages';

/**
 * Popup tests. The real main() runs in jsdom against the markup of the
 * popup.html the extension ships, so every id byId() looks up is pinned by
 * that page. chrome.* is stubbed at the boundary: storage answers the saved
 * settings, the content script answers the tab's video and the background
 * worker records what it is sent. getMessage echoes its key, so the
 * assertions read message keys instead of a catalog.
 */

// Under jsdom, Vite rewrites `new URL(..., import.meta.url)` to an http URL
// that fileURLToPath rejects, so the page is found through import.meta.dirname.
// The script tag is dropped: each case imports the popup module itself.
const POPUP_BODY = (
  /<body>([\s\S]*)<\/body>/.exec(readFileSync(path.join(import.meta.dirname, '..', 'popup.html'), 'utf-8'))?.[1] ?? ''
).replace(/<script[^>]*><\/script>/g, '');

type WorkerListener = (message: RuntimeMessage) => void;

interface PopupWorld {
  /** What chrome.storage.local holds */
  settings: Partial<PopupConfig>;
  /** The content script's answer for the active tab; an Error is a tab without the script */
  tab: { videoUrl?: string; videoTitle?: string } | Error;
  /** What the background worker reports as in flight */
  downloads?: ActiveDownloadSummary[];
}

const SETTINGS: PopupConfig = { serverUrl: 'https://video.example.com', folderPath: '/videos', apiToken: 'secret' };
const VIDEO = { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoTitle: 'Clip' };
const DOWNLOADING: ActiveDownloadSummary = {
  id: 1,
  videoUrl: VIDEO.videoUrl,
  videoTitle: 'Clip',
  progress: 10,
  status: 'downloading',
  startTime: 0,
};

/** Opens the popup on a tab; returns what the worker was sent and a way to message the popup */
async function openPopup(world: PopupWorld) {
  vi.resetModules();
  document.body.innerHTML = POPUP_BODY;
  const sent: RuntimeMessage[] = [];
  let workerListener: WorkerListener | undefined;
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => world.settings) } },
    runtime: {
      sendMessage: vi.fn(async (message: RuntimeMessage) => {
        sent.push(message);
        return message.action === 'getActiveDownloads' ? { downloads: world.downloads ?? [] } : undefined;
      }),
      onMessage: {
        addListener: vi.fn((listener: WorkerListener) => {
          workerListener = listener;
        }),
      },
      openOptionsPage: vi.fn(),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage: vi.fn(async () => {
        if (world.tab instanceof Error) {
          throw world.tab;
        }
        return world.tab;
      }),
    },
    i18n: { getMessage: vi.fn((key: string) => key) },
  });

  await import('./popup');
  // main() subscribes to the worker last, once the tab has answered
  await vi.waitFor(() => expect(workerListener).toBeDefined());

  return {
    sent,
    fromWorker: (message: RuntimeMessage) => workerListener?.(message),
  };
}

describe('popup', () => {
  beforeEach(() => {
    // startDownload re-reads the worker's list 100 ms after queuing; a fake
    // setTimeout keeps that read inside the test that started it
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the video on the tab to the background worker, with the saved API token', async () => {
    const popup = await openPopup({ settings: SETTINGS, tab: VIDEO });

    byId('downloadBtn').click();

    await vi.waitFor(() =>
      expect(popup.sent).toContainEqual({
        action: 'downloadVideo',
        videoUrl: VIDEO.videoUrl,
        videoTitle: VIDEO.videoTitle,
        serverUrl: SETTINGS.serverUrl,
        folderPath: SETTINGS.folderPath,
        apiToken: SETTINGS.apiToken,
      }),
    );
    expect(byId('status').textContent).toBe('addingToQueue');
  });

  it('leaves the API token out of the message when none is saved', async () => {
    const popup = await openPopup({
      settings: { serverUrl: 'http://localhost:3001', folderPath: '/videos' },
      tab: VIDEO,
    });

    byId('downloadBtn').click();

    const download = await vi.waitFor(() => {
      const message = popup.sent.find((sent) => sent.action === 'downloadVideo');
      expect(message).toBeDefined();
      return message;
    });
    expect(download).not.toHaveProperty('apiToken');
  });

  it('keeps the button disabled and points to the settings until a server and a folder are saved', async () => {
    await openPopup({ settings: {}, tab: VIDEO });

    expect(byId('configWarning').style.display).toBe('block');
    expect(byId<HTMLButtonElement>('downloadBtn').disabled).toBe(true);
  });

  it('moves the progress bar of a download the worker reports on', async () => {
    const popup = await openPopup({ settings: SETTINGS, tab: VIDEO, downloads: [DOWNLOADING] });
    const item = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-download-id="1"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    popup.fromWorker({ action: 'downloadProgress', downloadId: 1, progress: 42 });

    expect(item.querySelector<HTMLElement>('.download-item-progress-fill')?.style.width).toBe('42%');
    expect(item.querySelector('.download-item-status')?.textContent).toBe('42%');
  });

  it('drops a download from the list once the worker reports it finished', async () => {
    const world: PopupWorld = { settings: SETTINGS, tab: VIDEO, downloads: [DOWNLOADING] };
    const popup = await openPopup(world);
    await vi.waitFor(() => expect(document.querySelector('[data-download-id="1"]')).not.toBeNull());

    world.downloads = []; // the worker forgets a download as it reports it finished
    popup.fromWorker({ action: 'downloadComplete', downloadId: 1 });

    await vi.waitFor(() => expect(byId('activeDownloadsSection').style.display).toBe('none'));
    expect(document.querySelector('[data-download-id="1"]')).toBeNull();
  });

  it('asks for a page refresh when the tab has no content script to answer', async () => {
    // main() logs the failed tab message before it shows the hint
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await openPopup({
      settings: SETTINGS,
      tab: new Error('Could not establish connection. Receiving end does not exist.'),
    });

    expect(byId('noVideo').textContent).toBe('refreshAndRetry');
    expect(byId('noVideo').style.display).toBe('block');
  });
});
