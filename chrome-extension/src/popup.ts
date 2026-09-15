import { byId } from './lib/dom';
import { localizeDom } from './lib/i18n';
import type { ActiveDownloadSummary, ActiveDownloadsResponse, PopupConfig, RuntimeMessage } from './lib/messages';

/**
 * Popup script: shows the video on the current tab, starts downloads through
 * the background worker and renders the list of active downloads.
 */

interface PopupDownload {
  element: HTMLDivElement;
  progress: number;
}

/** Updates the progress bar and the percentage label of one download item. */
function applyProgressToItem(item: HTMLDivElement, progress: number): void {
  const progressFill = item.querySelector<HTMLElement>('.download-item-progress-fill');
  const statusLine = item.querySelector<HTMLElement>('.download-item-status');
  if (progressFill) {
    progressFill.style.width = `${progress}%`;
  }
  if (statusLine) {
    statusLine.textContent = `${progress}%`;
  }
}

/** Shows a status message (truncated to 50 characters) on one download item. */
function showProgressMessage(item: HTMLDivElement, message: string): void {
  const statusLine = item.querySelector<HTMLElement>('.download-item-status');
  if (statusLine) {
    statusLine.textContent = message.substring(0, 50) + (message.length > 50 ? '...' : '');
  }
}

async function main(): Promise<void> {
  localizeDom();
  const downloadBtn = byId<HTMLButtonElement>('downloadBtn');
  const optionsBtn = byId('optionsBtn');
  const videoInfo = byId('videoInfo');
  const videoTitle = byId('videoTitle');
  const videoUrl = byId('videoUrl');
  const status = byId('status');
  const progressContainer = byId('progressContainer');
  const configWarning = byId('configWarning');
  const optionsLink = byId<HTMLAnchorElement>('optionsLink');
  const noVideo = byId('noVideo');
  const activeDownloadsSection = byId('activeDownloadsSection');
  const activeDownloadsList = byId('activeDownloadsList');

  // Map to track downloads in the popup: downloadId -> { element, progress }
  const popupDownloads = new Map<number, PopupDownload>();

  function showStatus(type: 'info' | 'success' | 'error', message: string): void {
    status.className = `status ${type}`;
    status.textContent = message;
    status.style.display = 'block';
  }

  // Load configuration
  const config = (await chrome.storage.sync.get(['serverUrl', 'folderPath', 'apiToken'])) as Partial<PopupConfig>;

  if (!config.serverUrl || !config.folderPath) {
    configWarning.style.display = 'block';
    videoInfo.style.display = 'none';
    noVideo.style.display = 'none';
    downloadBtn.disabled = true;
  } else {
    configWarning.style.display = 'none';
  }

  function renderDownloadsList(downloads: ActiveDownloadSummary[]): void {
    activeDownloadsList.innerHTML = '';
    popupDownloads.clear();

    for (const download of downloads) {
      const item = createDownloadItem(download);
      activeDownloadsList.appendChild(item);
      popupDownloads.set(download.id, {
        element: item,
        progress: download.progress || 0,
      });
    }
  }

  async function loadActiveDownloads(): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({
        action: 'getActiveDownloads',
      })) as ActiveDownloadsResponse | undefined;
      const downloads = response?.downloads ?? [];
      if (downloads.length > 0) {
        activeDownloadsSection.style.display = 'block';
        renderDownloadsList(downloads);
      } else {
        activeDownloadsSection.style.display = 'none';
        activeDownloadsList.innerHTML = '';
        popupDownloads.clear();
      }
    } catch (error) {
      console.error('Error loading active downloads:', error);
    }
  }

  function createDownloadItem(download: ActiveDownloadSummary): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'download-item';
    item.dataset.downloadId = String(download.id);

    const header = document.createElement('div');
    header.className = 'download-item-header';

    const title = document.createElement('div');
    title.className = 'download-item-title';
    title.textContent = download.videoTitle || chrome.i18n.getMessage('video');
    title.title = download.videoUrl;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'download-item-cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.title = chrome.i18n.getMessage('cancelDownload');
    cancelBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        action: 'cancelDownload',
        downloadId: download.id,
      } satisfies RuntimeMessage);
    });

    header.appendChild(title);
    header.appendChild(cancelBtn);

    const progressBar = document.createElement('div');
    progressBar.className = 'download-item-progress';

    const progressFill = document.createElement('div');
    progressFill.className = 'download-item-progress-fill';
    progressFill.style.width = `${download.progress || 0}%`;

    progressBar.appendChild(progressFill);

    const statusLine = document.createElement('div');
    statusLine.className = 'download-item-status';
    statusLine.textContent =
      download.status === 'starting'
        ? chrome.i18n.getMessage('starting')
        : download.status === 'downloading'
          ? `${download.progress || 0}%`
          : chrome.i18n.getMessage('downloading');

    item.appendChild(header);
    item.appendChild(progressBar);
    item.appendChild(statusLine);

    return item;
  }

  function updateDownloadProgress(downloadId: number, progress: number | undefined, message: string | undefined): void {
    const download = popupDownloads.get(downloadId);
    if (!download) {
      return;
    }

    if (progress !== undefined && progress !== null) {
      download.progress = progress;
      applyProgressToItem(download.element, progress);
    } else if (message) {
      showProgressMessage(download.element, message);
    }
  }

  function removeDownloadFromUI(downloadId: number): void {
    const download = popupDownloads.get(downloadId);
    if (download) {
      download.element.remove();
      popupDownloads.delete(downloadId);
    }
  }

  // Load active downloads (background worker may be mid-download already)
  void loadActiveDownloads();

  // Get the current tab and its video info from the content script
  try {
    const tabId = await getActiveTabId();
    const response = (await chrome.tabs.sendMessage(tabId, {
      action: 'getVideoInfo',
    } satisfies RuntimeMessage)) as { videoUrl?: string; videoTitle?: string } | undefined;

    if (response?.videoUrl) {
      videoInfo.style.display = 'block';
      videoTitle.textContent = response.videoTitle || chrome.i18n.getMessage('video');
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
    // A connection error means the content script is not injected
    if (error instanceof Error && error.message.includes('Could not establish connection')) {
      noVideo.textContent = chrome.i18n.getMessage('refreshAndRetry');
    }
    noVideo.style.display = 'block';
    videoInfo.style.display = 'none';
  }

  // Download button handler
  downloadBtn.addEventListener('click', () => {
    void startDownload(config);
  });

  /** Asks the content script for the current video and sends it to the background worker. */
  async function startDownload(config: Partial<PopupConfig>): Promise<void> {
    if (!config.serverUrl || !config.folderPath) {
      showStatus('error', chrome.i18n.getMessage('configureFirst'));
      return;
    }

    try {
      const tabId = await getActiveTabId();
      const response = (await chrome.tabs.sendMessage(tabId, {
        action: 'getVideoInfo',
      } satisfies RuntimeMessage)) as { videoUrl?: string; videoTitle?: string } | undefined;

      if (!response?.videoUrl) {
        showStatus('error', chrome.i18n.getMessage('noVideo'));
        return;
      }

      downloadBtn.disabled = false; // keep enabled so the user can add more downloads
      showStatus('info', chrome.i18n.getMessage('addingToQueue'));

      await chrome.runtime.sendMessage({
        action: 'downloadVideo',
        videoUrl: response.videoUrl,
        videoTitle: response.videoTitle || 'Wideo',
        serverUrl: config.serverUrl,
        folderPath: config.folderPath,
        ...(config.apiToken ? { apiToken: config.apiToken } : {}),
      } satisfies RuntimeMessage);

      // Reload active downloads to show the new one
      setTimeout(() => void loadActiveDownloads(), 100);
    } catch (error) {
      showStatus(
        'error',
        chrome.i18n.getMessage('errorWithMessage', [error instanceof Error ? error.message : String(error)]),
      );
      downloadBtn.disabled = false;
      progressContainer.classList.remove('active');
    }
  }

  // Options button handler
  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  optionsLink.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Listen for download progress updates from the background worker
  chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
    if (message.action === 'downloadStart') {
      void loadActiveDownloads();
    } else if (message.action === 'downloadProgress') {
      updateDownloadProgress(message.downloadId, message.progress, message.message);
    } else if (message.action === 'downloadComplete') {
      removeDownloadFromUI(message.downloadId);
      void loadActiveDownloads();
    } else if (message.action === 'downloadError') {
      removeDownloadFromUI(message.downloadId);
      void loadActiveDownloads();
    } else if (message.action === 'downloadCancelled') {
      removeDownloadFromUI(message.downloadId);
      void loadActiveDownloads();
    }
  });
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    throw new Error('No active tab');
  }
  return tab.id;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main());
} else {
  void main();
}
