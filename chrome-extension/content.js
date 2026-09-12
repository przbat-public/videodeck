// Content script to detect video on the page

function getVideoInfo() {
  try {
    const url = window.location.href;

    // YouTube detection
    if (url.includes('youtube.com/watch') || url.includes('youtu.be/')) {
      const videoId = getYouTubeVideoId(url);
      if (!videoId) {
        return null;
      }

      // Try multiple selectors for YouTube title
      const titleSelectors = [
        'h1.ytd-watch-metadata yt-formatted-string',
        'h1.title yt-formatted-string',
        'h1.ytd-watch-metadata',
        'h1.title',
      ];

      let title = null;
      for (const selector of titleSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          title = element.textContent?.trim() || element.innerText?.trim();
          if (title && title !== 'YouTube' && title.length > 0) {
            break;
          }
        }
      }

      // Fallback to meta tag or document title
      if (!title || title === 'YouTube') {
        const metaTitle = document.querySelector('meta[property="og:title"]');
        if (metaTitle && metaTitle.content) {
          title = metaTitle.content;
        } else {
          title = document.title.replace(' - YouTube', '').trim() || 'YouTube Video';
        }
      }

      return {
        videoUrl: url,
        videoTitle: title || 'YouTube Video',
        videoId: videoId,
        platform: 'youtube',
      };
    }

    // Generic video detection - look for video elements
    const videoElement = document.querySelector('video');
    if (videoElement && videoElement.src) {
      return {
        videoUrl: videoElement.src || url,
        videoTitle: document.title || 'Video',
        platform: 'generic',
      };
    }

    // Check for common video URL patterns
    if (url.match(/\.(mp4|webm|ogg|mov|avi|mkv)(\?|$)/i)) {
      return {
        videoUrl: url,
        videoTitle: document.title || 'Video',
        platform: 'direct',
      };
    }

    return null;
  } catch (error) {
    console.error('Error in getVideoInfo:', error);
    return null;
  }
}

function getYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

// Listen for messages from popup - this is the main way popup gets video info
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideoInfo') {
    const videoInfo = getVideoInfo();
    sendResponse(videoInfo);
    return true;
  }
  return false;
});

// Watch for URL changes (for SPA navigation like YouTube)
let lastUrl = window.location.href;
let lastVideoId = null;

function checkForVideoChange() {
  const currentUrl = window.location.href;
  const currentVideoId = getYouTubeVideoId(currentUrl);

  // Check if URL changed
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    lastVideoId = currentVideoId;
    return true;
  }

  // Check if video ID changed (for YouTube)
  if (currentVideoId && currentVideoId !== lastVideoId) {
    lastVideoId = currentVideoId;
    return true;
  }

  return false;
}

// Simple observer for DOM changes (debounced)
let observerTimeout = null;
const observer = new MutationObserver(() => {
  clearTimeout(observerTimeout);
  observerTimeout = setTimeout(() => {
    // Just check if video info is available now
    const videoInfo = getVideoInfo();
    if (videoInfo && videoInfo.videoId !== lastVideoId) {
      lastVideoId = videoInfo.videoId;
    }
  }, 500);
});

// Watch for URL changes
function setupUrlWatcher() {
  // Check periodically
  setInterval(() => {
    checkForVideoChange();
  }, 1000);

  // Listen to navigation events
  window.addEventListener('popstate', () => {
    setTimeout(() => checkForVideoChange(), 100);
  });

  // Override history methods
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(history, args);
    setTimeout(() => checkForVideoChange(), 100);
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(history, args);
    setTimeout(() => checkForVideoChange(), 100);
  };
}

// Initialize
function init() {
  try {
    // Initial check
    const initialInfo = getVideoInfo();
    if (initialInfo && initialInfo.videoId) {
      lastVideoId = initialInfo.videoId;
    }

    // Start observing DOM changes
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    // Setup URL watcher
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
