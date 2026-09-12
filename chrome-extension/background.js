// Background service worker for Chrome extension

// Map to track active downloads: downloadId -> { videoUrl, videoTitle, progress, status }
const activeDownloads = new Map();
let downloadIdCounter = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadVideo') {
    const downloadId = ++downloadIdCounter;
    const videoTitle = message.videoTitle || 'Wideo';

    // Add to active downloads
    activeDownloads.set(downloadId, {
      videoUrl: message.videoUrl,
      videoTitle: videoTitle,
      progress: 0,
      status: 'starting',
      startTime: Date.now(),
    });

    updateBadge();
    notifyDownloadUpdate(downloadId, 'start', { videoTitle });

    downloadVideo(
      downloadId,
      message.videoUrl,
      message.serverUrl,
      message.folderPath,
      videoTitle
    ).catch((error) => {
      activeDownloads.delete(downloadId);
      updateBadge();
      chrome.runtime.sendMessage({
        action: 'downloadError',
        downloadId: downloadId,
        error: error.message,
      });
    });
    return true; // Keep channel open for async response
  } else if (message.action === 'getActiveDownloads') {
    sendResponse({
      downloads: Array.from(activeDownloads.entries()).map(([id, data]) => ({
        id,
        ...data,
      })),
    });
    return true;
  } else if (message.action === 'cancelDownload') {
    // Note: Cancelling SSE stream is complex, so we'll just mark it as cancelled
    // The actual download will continue on server side
    if (activeDownloads.has(message.downloadId)) {
      activeDownloads.delete(message.downloadId);
      updateBadge();
      chrome.runtime.sendMessage({
        action: 'downloadCancelled',
        downloadId: message.downloadId,
      });
    }
    return true;
  }
});

async function downloadVideo(downloadId, videoUrl, serverUrl, folderPath, videoTitle) {
  const apiUrl = `${serverUrl}/api/folder/download-video`;

  // Check if download was cancelled
  if (!activeDownloads.has(downloadId)) {
    return;
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        folderPath: folderPath,
        videoUrl: videoUrl,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
    }

    // Update status
    if (activeDownloads.has(downloadId)) {
      activeDownloads.get(downloadId).status = 'downloading';
    }

    // Handle Server-Sent Events (SSE) stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      // Check if download was cancelled
      if (!activeDownloads.has(downloadId)) {
        reader.cancel();
        return;
      }

      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));

            if (data.type === 'start') {
              notifyDownloadUpdate(downloadId, 'progress', {
                progress: 0,
                message: data.message || 'Rozpoczynanie pobierania...',
              });
            } else if (data.type === 'output') {
              // Try to extract progress from yt-dlp output
              const progress = extractProgress(data.message);
              if (activeDownloads.has(downloadId)) {
                const download = activeDownloads.get(downloadId);
                if (progress !== undefined) {
                  download.progress = progress;
                }
              }
              notifyDownloadUpdate(downloadId, 'progress', {
                progress: progress,
                message: data.message,
              });
            } else if (data.type === 'done') {
              activeDownloads.delete(downloadId);
              updateBadge();
              notifyDownloadUpdate(downloadId, 'complete', {
                message: data.message || 'Pobieranie zakończone',
              });
              return;
            } else if (data.type === 'error') {
              activeDownloads.delete(downloadId);
              updateBadge();
              throw new Error(data.error || 'Błąd podczas pobierania');
            }
          } catch (parseError) {
            console.error('Error parsing SSE data:', parseError);
          }
        }
      }
    }

    // If we reach here, the stream ended without 'done' event
    activeDownloads.delete(downloadId);
    updateBadge();
    notifyDownloadUpdate(downloadId, 'complete', {
      message: 'Pobieranie zakończone',
    });
  } catch (error) {
    activeDownloads.delete(downloadId);
    updateBadge();
    notifyDownloadUpdate(downloadId, 'error', {
      error: error.message || 'Nieznany błąd',
    });
    throw error;
  }
}

function notifyDownloadUpdate(downloadId, type, data) {
  chrome.runtime
    .sendMessage({
      action: `download${type.charAt(0).toUpperCase() + type.slice(1)}`,
      downloadId: downloadId,
      ...data,
    })
    .catch(() => {
      // Ignore errors if no listeners (popup might be closed)
    });
}

function updateBadge() {
  const count = activeDownloads.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#1976d2' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function extractProgress(message) {
  // Try to extract progress percentage from yt-dlp output
  // Example: "[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:45"
  const percentMatch = message.match(/(\d+\.?\d*)%/);
  if (percentMatch) {
    return Math.min(100, Math.max(0, parseFloat(percentMatch[1])));
  }

  // If message contains "100%" or "completed", return 100
  if (message.toLowerCase().includes('100%') || message.toLowerCase().includes('completed')) {
    return 100;
  }

  // Default: return undefined to keep current progress
  return undefined;
}
