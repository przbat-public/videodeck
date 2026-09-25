import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeMessage, VideoInfo } from './lib/messages';

/**
 * Content-script tests. The popup learns about the current page through the
 * `getVideoInfo` message, so these tests drive that handler against a stubbed
 * `chrome` API and a hand-built DOM (vitest runs in the `node` environment, so
 * there is no jsdom here). They pin the rule "a YouTube URL the shared helper
 * understands is a video page, everything else takes the generic path".
 */

type MessageHandler = (message: RuntimeMessage, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

type MockFn = ReturnType<typeof vi.fn>;

interface ContentChromeMock {
  runtime: { onMessage: { addListener: MockFn } };
}

/** The smallest document stand-in the content script touches. */
function fakeDocument(title: string, videoSrc?: string): Record<string, unknown> {
  return {
    title,
    body: null,
    // "loading" keeps init() from starting the URL watcher: the tests only
    // exercise the message handler.
    readyState: 'loading',
    addEventListener: vi.fn(),
    querySelector: vi.fn((selector: string) => (selector === 'video' && videoSrc ? { src: videoSrc } : null)),
  };
}

describe('content script video detection', () => {
  let messageHandler: MessageHandler;
  let chromeMock: ContentChromeMock;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Imports the content script for one page URL and captures its message listener. */
  async function loadContentScript(url: string, title: string, videoSrc?: string): Promise<void> {
    vi.resetModules();
    chromeMock = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: MessageHandler) => {
            messageHandler = listener;
          }),
        },
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    vi.stubGlobal('document', fakeDocument(title, videoSrc));
    vi.stubGlobal('window', { location: { href: url } });
    vi.stubGlobal('MutationObserver', class {});
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('HTMLMetaElement', class {});

    await import('./content');
    expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  }

  /** Asks the content script for the current page's video, the way the popup does. */
  function askForVideoInfo(): VideoInfo | null {
    let response: VideoInfo | null = null;
    const channelKept = messageHandler({ action: 'getVideoInfo' }, {}, (value) => {
      response = value as VideoInfo | null;
    });
    expect(channelKept).toBe(true);
    return response;
  }

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=share-me',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ])('reports the video on %s', async (url) => {
    await loadContentScript(url, 'Some Video - YouTube');

    expect(askForVideoInfo()).toEqual({
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      videoTitle: 'Some Video',
      videoId: 'dQw4w9WgXcQ',
      platform: 'youtube',
    });
  });

  it('falls back to generic detection on a page outside YouTube', async () => {
    await loadContentScript('https://example.com/clip', 'Clip', 'https://cdn.example.com/clip.mp4');

    expect(askForVideoInfo()).toEqual({
      videoUrl: 'https://cdn.example.com/clip.mp4',
      videoTitle: 'Clip',
      platform: 'generic',
    });
  });

  it('reports no video on a YouTube page without a video id', async () => {
    await loadContentScript('https://www.youtube.com/', 'YouTube');

    expect(askForVideoInfo()).toBeNull();
  });
});
