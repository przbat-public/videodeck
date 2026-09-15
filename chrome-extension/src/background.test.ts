import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeMessage } from './lib/messages';

/**
 * Background service-worker tests. The `chrome` API is stubbed before the
 * module is imported (it registers its message listener at import time), and
 * `fetch` is stubbed with an SSE ReadableStream.
 */

type MessageHandler = (message: RuntimeMessage, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

interface ChromeMock {
  runtime: {
    id: string;
    onMessage: { addListener: (listener: MessageHandler) => void };
    onStartup: { addListener: ReturnType<typeof vi.fn> };
    sendMessage: ReturnType<typeof vi.fn>;
  };
  action: {
    setBadgeText: ReturnType<typeof vi.fn>;
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  };
  storage: {
    session: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
  i18n: { getMessage: ReturnType<typeof vi.fn> };
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of encoded) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(sseStream(chunks), { status: 200 });
}

describe('background service worker', () => {
  let chromeMock: ChromeMock;
  let fetchMock: ReturnType<typeof vi.fn>;
  let messageListener: MessageHandler;

  beforeEach(async () => {
    vi.resetModules();
    chromeMock = {
      runtime: {
        id: 'test-extension-id',
        onMessage: {
          addListener: vi.fn((listener: typeof messageListener) => {
            messageListener = listener;
          }),
        },
        onStartup: { addListener: vi.fn() },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      action: {
        setBadgeText: vi.fn().mockResolvedValue(undefined),
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      i18n: { getMessage: vi.fn((key: string) => key) },
    };
    vi.stubGlobal('chrome', chromeMock);
    fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await import('./background');
    expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const downloadMessage = (overrides: Partial<RuntimeMessage & { action: 'downloadVideo' }> = {}) => ({
    action: 'downloadVideo' as const,
    videoUrl: 'https://youtu.be/aaaaaaaaaaa',
    videoTitle: 'My Video',
    serverUrl: 'http://localhost:3001',
    folderPath: '/videos/a',
    apiToken: 'secret-token',
    ...overrides,
  });

  it('streams a download to completion: events, badge and auth header', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"downloadStart","videoTitle":"My Video"}\n\n',
        'data: {"type":"downloadProgress","progress":42,"message":"42.0%"}\n\n',
        ': ping\n\n',
        'data: {"type":"downloadComplete","message":"done"}\n\n',
      ]),
    );

    messageListener(downloadMessage(), { id: 'test-extension-id' }, () => undefined);
    await vi.waitFor(() =>
      expect(
        chromeMock.runtime.sendMessage.mock.calls.some(
          ([message]) => (message as { action?: string }).action === 'downloadComplete',
        ),
      ).toBe(true),
    );

    const progressMessages = chromeMock.runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { action?: string }).action === 'downloadProgress',
    );
    expect(progressMessages.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/folder/download-video',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('reports an error when the stream ends without a downloadComplete event', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"type":"downloadStart"}\n\n']));

    messageListener(downloadMessage(), { id: 'test-extension-id' }, () => undefined);
    await vi.waitFor(() =>
      expect(
        chromeMock.runtime.sendMessage.mock.calls.some(
          ([message]) => (message as { action?: string }).action === 'downloadError',
        ),
      ).toBe(true),
    );
    const errorMessage = chromeMock.runtime.sendMessage.mock.calls.find(
      ([message]) => (message as { action?: string }).action === 'downloadError',
    )?.[0] as { error?: string };
    expect(errorMessage.error).toBe('streamEndedUnexpectedly');
  });

  it('rejects messages from other extensions', () => {
    expect(messageListener(downloadMessage(), { id: 'other-extension-id' }, () => undefined)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a download and clears the badge', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"type":"downloadStart"}\n\n']));

    messageListener(downloadMessage(), { id: 'test-extension-id' }, () => undefined);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    messageListener({ action: 'cancelDownload', downloadId: 1 }, { id: 'test-extension-id' }, () => undefined);

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('restores persisted downloads on startup as errors, never as successes', async () => {
    chromeMock.storage.session.get.mockResolvedValue({
      activeDownloads: [{ downloadId: 7, videoTitle: 'Lost Video', videoUrl: 'https://youtu.be/aaaaaaaaaaa' }],
    });

    const startupListeners = chromeMock.runtime.onStartup.addListener.mock.calls.map(
      ([listener]) => listener as () => void,
    );
    expect(startupListeners).toHaveLength(1);
    startupListeners[0]?.();

    await vi.waitFor(() =>
      expect(
        chromeMock.runtime.sendMessage.mock.calls.some(
          ([message]) => (message as { action?: string }).action === 'downloadError',
        ),
      ).toBe(true),
    );
    const errorMessage = chromeMock.runtime.sendMessage.mock.calls.find(
      ([message]) => (message as { action?: string }).action === 'downloadError',
    )?.[0] as { error?: string };
    expect(errorMessage.error).toBe('workerRestarted');
    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith('activeDownloads');
  });
});
