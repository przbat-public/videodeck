/**
 * Messages exchanged between the popup, the content script and the background
 * service worker through chrome.runtime / chrome.tabs.
 */

/** Settings stored in chrome.storage.sync by the options page */
export interface PopupConfig {
  serverUrl: string;
  folderPath: string;
}

/** Video info gathered by the content script on the current page */
export interface VideoInfo {
  videoUrl: string;
  videoTitle: string;
  videoId?: string;
  platform: 'youtube' | 'generic' | 'direct';
}

/** Snapshot of a download sent from the background worker to the popup */
export interface ActiveDownloadSummary {
  id: number;
  videoUrl: string;
  videoTitle: string;
  progress: number;
  status: 'starting' | 'downloading';
  startTime: number;
}

export type RuntimeMessage =
  // popup → background
  | {
      action: 'downloadVideo';
      videoUrl: string;
      videoTitle: string;
      serverUrl: string;
      folderPath: string;
    }
  | { action: 'getActiveDownloads' }
  | { action: 'cancelDownload'; downloadId: number }
  // popup ↔ content script
  | { action: 'getVideoInfo' }
  // background → popup
  | { action: 'downloadStart'; downloadId: number; videoTitle?: string }
  | { action: 'downloadProgress'; downloadId: number; progress?: number; message?: string }
  | { action: 'downloadComplete'; downloadId: number; message?: string }
  | { action: 'downloadError'; downloadId: number; error?: string }
  | { action: 'downloadCancelled'; downloadId: number };

/** Response of `getActiveDownloads` */
export interface ActiveDownloadsResponse {
  downloads: ActiveDownloadSummary[];
}
