// Popup script for Chrome extension

document.addEventListener('DOMContentLoaded', async () => {
  const downloadBtn = document.getElementById('downloadBtn');
  const optionsBtn = document.getElementById('optionsBtn');
  const videoInfo = document.getElementById('videoInfo');
  const videoTitle = document.getElementById('videoTitle');
  const videoUrl = document.getElementById('videoUrl');
  const status = document.getElementById('status');
  const progressContainer = document.getElementById('progressContainer');
  const configWarning = document.getElementById('configWarning');
  const optionsLink = document.getElementById('optionsLink');
  const noVideo = document.getElementById('noVideo');
  const activeDownloadsSection = document.getElementById('activeDownloadsSection');
  const activeDownloadsList = document.getElementById('activeDownloadsList');

  // Map to track downloads in popup: downloadId -> { element, progress }
  const popupDownloads = new Map();

  // Load configuration
  const config = await chrome.storage.sync.get(['serverUrl', 'folderPath']);

  if (!config.serverUrl || !config.folderPath) {
    configWarning.style.display = 'block';
    videoInfo.style.display = 'none';
    noVideo.style.display = 'none';
    downloadBtn.disabled = true;
  } else {
    configWarning.style.display = 'none';
  }

  // Load active downloads
  loadActiveDownloads();

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Get video info from content script
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoInfo' });

    if (response && response.videoUrl) {
      videoInfo.style.display = 'block';
      videoTitle.textContent = response.videoTitle || 'Wideo';
      videoUrl.textContent = response.videoUrl;

      if (config.serverUrl && config.folderPath) {
        downloadBtn.disabled = false;
      }
    } else {
      noVideo.style.display = 'block';
      videoInfo.style.display = 'none';
    }
  } catch (error) {
    console.error('Error getting video info:', error);
    // Check if it's a connection error (content script not injected)
    if (error.message && error.message.includes('Could not establish connection')) {
      noVideo.textContent = 'Odśwież stronę i spróbuj ponownie';
    }
    noVideo.style.display = 'block';
    videoInfo.style.display = 'none';
  }

  // Download button handler
  downloadBtn.addEventListener('click', async () => {
    if (!config.serverUrl || !config.folderPath) {
      showStatus('error', 'Skonfiguruj najpierw URL serwera i folderPath w opcjach');
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoInfo' });

      if (!response || !response.videoUrl) {
        showStatus('error', 'Nie znaleziono wideo na tej stronie');
        return;
      }

      downloadBtn.disabled = false; // Keep enabled so user can add more downloads
      showStatus('info', 'Dodawanie do kolejki pobierania...');
      // Don't show single progress bar anymore - use downloads list instead

      // Send download request to background script
      chrome.runtime.sendMessage(
        {
          action: 'downloadVideo',
          videoUrl: response.videoUrl,
          videoTitle: response.videoTitle || 'Wideo',
          serverUrl: config.serverUrl,
          folderPath: config.folderPath,
        },
        () => {
          if (chrome.runtime.lastError) {
            showStatus('error', chrome.runtime.lastError.message);
          } else {
            // Reload active downloads to show the new one
            setTimeout(() => loadActiveDownloads(), 100);
          }
        }
      );
    } catch (error) {
      showStatus('error', `Błąd: ${error.message}`);
      downloadBtn.disabled = false;
      progressContainer.classList.remove('active');
    }
  });

  // Options button handler
  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Listen for download progress updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadStart') {
      loadActiveDownloads();
    } else if (message.action === 'downloadProgress') {
      updateDownloadProgress(message.downloadId, message.progress, message.message);
    } else if (message.action === 'downloadComplete') {
      removeDownloadFromUI(message.downloadId);
      loadActiveDownloads();
    } else if (message.action === 'downloadError') {
      removeDownloadFromUI(message.downloadId);
      loadActiveDownloads();
    } else if (message.action === 'downloadCancelled') {
      removeDownloadFromUI(message.downloadId);
      loadActiveDownloads();
    }
  });

  async function loadActiveDownloads() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getActiveDownloads' });
      if (response && response.downloads) {
        if (response.downloads.length > 0) {
          activeDownloadsSection.style.display = 'block';
          renderDownloadsList(response.downloads);
        } else {
          activeDownloadsSection.style.display = 'none';
          activeDownloadsList.innerHTML = '';
          popupDownloads.clear();
        }
      }
    } catch (error) {
      console.error('Error loading active downloads:', error);
    }
  }

  function renderDownloadsList(downloads) {
    activeDownloadsList.innerHTML = '';
    popupDownloads.clear();

    downloads.forEach((download) => {
      const item = createDownloadItem(download);
      activeDownloadsList.appendChild(item);
      popupDownloads.set(download.id, {
        element: item,
        progress: download.progress || 0,
      });
    });
  }

  function createDownloadItem(download) {
    const item = document.createElement('div');
    item.className = 'download-item';
    item.dataset.downloadId = download.id;

    const header = document.createElement('div');
    header.className = 'download-item-header';

    const title = document.createElement('div');
    title.className = 'download-item-title';
    title.textContent = download.videoTitle || 'Wideo';
    title.title = download.videoUrl;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'download-item-cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Anuluj pobieranie';
    cancelBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'cancelDownload',
        downloadId: download.id,
      });
    });

    header.appendChild(title);
    header.appendChild(cancelBtn);

    const progressBar = document.createElement('div');
    progressBar.className = 'download-item-progress';

    const progressFill = document.createElement('div');
    progressFill.className = 'download-item-progress-fill';
    progressFill.style.width = `${download.progress || 0}%`;

    progressBar.appendChild(progressFill);

    const status = document.createElement('div');
    status.className = 'download-item-status';
    status.textContent =
      download.status === 'starting'
        ? 'Rozpoczynanie...'
        : download.status === 'downloading'
          ? `${download.progress || 0}%`
          : 'Pobieranie...';

    item.appendChild(header);
    item.appendChild(progressBar);
    item.appendChild(status);

    return item;
  }

  function updateDownloadProgress(downloadId, progress, message) {
    const download = popupDownloads.get(downloadId);
    if (download) {
      const item = download.element;
      const progressFill = item.querySelector('.download-item-progress-fill');
      const status = item.querySelector('.download-item-status');

      if (progress !== undefined && progress !== null) {
        download.progress = progress;
        progressFill.style.width = `${progress}%`;
        status.textContent = `${progress}%`;
      } else if (message) {
        status.textContent = message.substring(0, 50) + (message.length > 50 ? '...' : '');
      }
    }
  }

  function removeDownloadFromUI(downloadId) {
    const download = popupDownloads.get(downloadId);
    if (download) {
      download.element.remove();
      popupDownloads.delete(downloadId);
    }
  }

  function showStatus(type, message) {
    status.className = `status ${type}`;
    status.textContent = message;
    status.style.display = 'block';
  }
});
