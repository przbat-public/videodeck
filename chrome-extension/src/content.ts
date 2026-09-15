import type { RuntimeMessage, VideoInfo } from './lib/messages';
import { getYouTubeVideoId, toWatchUrl } from './lib/youtube';

/**
 * Content script: detects the video on the current page (YouTube or a direct
 * video URL) and answers the popup's `getVideoInfo` messages.
 */

const YOUTUBE_TITLE_SELECTORS = [
  'h1.ytd-watch-metadata yt-formatted-string',
  'h1.title yt-formatted-string',
  'h1.ytd-watch-metadata',
  'h1.title',
] as const;

function getVideoInfo(): VideoInfo | null {
  try {
    const url = window.location.href;

    // YouTube detection
    if (url.includes('youtube.com/watch') || url.includes('youtu.be/')) {
      return getYouTubeVideoInfo(url);
    }

    return getGenericVideoInfo(url);
  } catch (error) {
    console.error('Error in getVideoInfo:', error);
    return null;
  }
}

/** Builds the YouTube video info from the page DOM and its URL. */
function getYouTubeVideoInfo(url: string): VideoInfo | null {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }

  let title = findYoutubeTitle();

  // Fallback to the meta tag or the document title
  if (!title || title === 'YouTube') {
    title = readMetaTitle() ?? (document.title.replace(' - YouTube', '').trim() || 'YouTube Video');
  }

  return {
    // Canonical single-video URL: the page URL may carry &list=…&index=…
    // (opened from a playlist), which would make the server download the
    // whole playlist instead of this one video.
    videoUrl: toWatchUrl(videoId),
    videoTitle: title || 'YouTube Video',
    videoId,
    platform: 'youtube',
  };
}

/** Finds a plausible video title in the YouTube player markup. */
function findYoutubeTitle(): string | null {
  for (const selector of YOUTUBE_TITLE_SELECTORS) {
    const element = document.querySelector(selector);
    const text = element?.textContent?.trim() || (element instanceof HTMLElement ? element.innerText.trim() : '');
    if (text && text !== 'YouTube' && text.length > 0) {
      return text;
    }
  }
  return null;
}

/** Reads the og:title meta tag, when present and non-empty. */
function readMetaTitle(): string | null {
  const metaTitle = document.querySelector('meta[property="og:title"]');
  if (metaTitle instanceof HTMLMetaElement && metaTitle.content) {
    return metaTitle.content;
  }
  return null;
}

/** Detects a non-YouTube video: a <video> element or a direct video URL. */
function getGenericVideoInfo(url: string): VideoInfo | null {
  // Generic video detection - look for video elements
  const videoElement = document.querySelector('video');
  if (videoElement?.src) {
    return {
      videoUrl: videoElement.src || url,
      videoTitle: document.title || 'Video',
      platform: 'generic',
    };
  }

  // Common direct video URL patterns
  if (url.match(/\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i)) {
    return {
      videoUrl: url,
      videoTitle: document.title || 'Video',
      platform: 'direct',
    };
  }

  return null;
}

// Answer the popup's requests - the main way the popup gets video info
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.action === 'getVideoInfo') {
    sendResponse(getVideoInfo());
    return true;
  }
  return false;
});

// Watch for URL changes (SPA navigation on YouTube)
let lastUrl = window.location.href;
let lastVideoId: string | null = null;

function checkForVideoChange(): boolean {
  const currentUrl = window.location.href;
  const currentVideoId = getYouTubeVideoId(currentUrl);

  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    lastVideoId = currentVideoId;
    return true;
  }

  if (currentVideoId && currentVideoId !== lastVideoId) {
    lastVideoId = currentVideoId;
    return true;
  }

  return false;
}

// Simple observer for DOM changes (debounced)
let observerTimeout: number | null = null;
const observer = new MutationObserver(() => {
  if (observerTimeout !== null) {
    clearTimeout(observerTimeout);
  }
  observerTimeout = setTimeout(() => {
    // Just remember whether video info is available now
    const videoInfo = getVideoInfo();
    if (videoInfo?.videoId && videoInfo.videoId !== lastVideoId) {
      lastVideoId = videoInfo.videoId;
    }
  }, 500);
});

function setupUrlWatcher(): void {
  // Poll periodically
  setInterval(() => {
    checkForVideoChange();
  }, 1000);

  // React to navigation events
  window.addEventListener('popstate', () => {
    setTimeout(() => checkForVideoChange(), 100);
  });

  // Override history methods (SPA routers change the URL this way)
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args: Parameters<History['pushState']>) => {
    originalPushState(...args);
    setTimeout(() => checkForVideoChange(), 100);
  };
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    originalReplaceState(...args);
    setTimeout(() => checkForVideoChange(), 100);
  };
}

function init(): void {
  try {
    // Initial check
    const initialInfo = getVideoInfo();
    if (initialInfo?.videoId) {
      lastVideoId = initialInfo.videoId;
    }

    // Start observing DOM changes
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    setupUrlWatcher();
  } catch (error) {
    console.error('Error initializing content script:', error);
  }
}

// Start when ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // DOM already loaded, wait a bit for YouTube to load
  setTimeout(init, 500);
}
