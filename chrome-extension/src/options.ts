import { byId } from './lib/dom';
import { localizeDom } from './lib/i18n';
import type { PopupConfig } from './lib/messages';

/**
 * Options page: saves the server URL and the target folder path to
 * chrome.storage.local and tests the connection to the server.
 */

function showStatus(element: HTMLElement, type: 'info' | 'success' | 'error', message: string): void {
  element.className = `status ${type}`;
  element.textContent = message;
  element.style.display = 'block';

  // Hide success messages after 5 seconds
  if (type === 'success') {
    setTimeout(() => {
      element.style.display = 'none';
    }, 5000);
  }
}

async function main(): Promise<void> {
  localizeDom();
  const form = byId<HTMLFormElement>('optionsForm');
  const serverUrlInput = byId<HTMLInputElement>('serverUrl');
  const folderPathInput = byId<HTMLInputElement>('folderPath');
  const apiTokenInput = byId<HTMLInputElement>('apiToken');
  const testBtn = byId<HTMLButtonElement>('testBtn');
  const status = byId('status');

  // Load saved settings
  const config = (await chrome.storage.local.get(['serverUrl', 'folderPath', 'apiToken'])) as Partial<PopupConfig>;
  if (config.serverUrl) {
    serverUrlInput.value = config.serverUrl;
  }
  if (config.folderPath) {
    folderPathInput.value = config.folderPath;
  }
  if (config.apiToken) {
    apiTokenInput.value = config.apiToken;
  }

  // Form submit handler
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings(serverUrlInput.value.trim(), folderPathInput.value.trim(), apiTokenInput.value.trim(), status);
  });

  // Test connection button handler
  testBtn.addEventListener('click', () => {
    const serverUrl = serverUrlInput.value.trim();

    if (!serverUrl) {
      showStatus(status, 'error', chrome.i18n.getMessage('enterServerUrl'));
      return;
    }

    void testConnection(serverUrl, status, testBtn);
  });
}

/** Validates the inputs and stores them in chrome.storage.local. */
async function saveSettings(
  serverUrl: string,
  folderPath: string,
  apiToken: string,
  status: HTMLElement,
): Promise<void> {
  if (!serverUrl || !folderPath) {
    showStatus(status, 'error', chrome.i18n.getMessage('fillAllFields'));
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    showStatus(status, 'error', chrome.i18n.getMessage('invalidServerUrl'));
    return;
  }
  // The bearer token travels on every request: refuse non-http(s) schemes
  // and warn about plain http (token in cleartext on the LAN).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    showStatus(status, 'error', chrome.i18n.getMessage('invalidServerUrl'));
    return;
  }
  if (parsed.protocol === 'http:' && apiToken.length > 0) {
    showStatus(status, 'error', chrome.i18n.getMessage('httpTokenWarning'));
    return;
  }

  // The background worker fetches this origin — ask for the host permission
  // now (localhost is granted statically in the manifest, other hosts are
  // optional and prompt once).
  const originPattern = `${parsed.origin}/*`;
  const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!alreadyGranted) {
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      showStatus(status, 'error', chrome.i18n.getMessage('hostPermissionDenied'));
      return;
    }
  }

  try {
    await chrome.storage.local.set({
      serverUrl,
      folderPath,
      ...(apiToken.length > 0 ? { apiToken } : {}),
    });
    showStatus(status, 'success', chrome.i18n.getMessage('settingsSaved'));
  } catch (error) {
    showStatus(
      status,
      'error',
      chrome.i18n.getMessage('saveError', [error instanceof Error ? error.message : String(error)]),
    );
  }
}

/** Pings the server's /health endpoint and reports the result in the status line. */
async function testConnection(serverUrl: string, status: HTMLElement, testBtn: HTMLButtonElement): Promise<void> {
  testBtn.disabled = true;
  testBtn.textContent = chrome.i18n.getMessage('testingConnection');
  showStatus(status, 'info', chrome.i18n.getMessage('testingConnection'));

  try {
    const response = await fetch(`${serverUrl}/health`);
    if (response.ok) {
      const data: unknown = await response.json();
      const statusOk = typeof data === 'object' && data !== null && 'status' in data && data.status === 'ok';
      showStatus(
        status,
        statusOk ? 'success' : 'error',
        statusOk ? chrome.i18n.getMessage('connectionOk') : chrome.i18n.getMessage('connectionBadStatus'),
      );
    } else {
      showStatus(status, 'error', chrome.i18n.getMessage('httpError', [String(response.status)]));
    }
  } catch (error) {
    showStatus(
      status,
      'error',
      chrome.i18n.getMessage('connectionError', [error instanceof Error ? error.message : String(error)]),
    );
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = chrome.i18n.getMessage('testConnection');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main());
} else {
  void main();
}
