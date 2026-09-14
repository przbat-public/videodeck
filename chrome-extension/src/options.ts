import { byId } from './lib/dom';
import { localizeDom } from './lib/i18n';
import type { PopupConfig } from './lib/messages';

/**
 * Options page: saves the server URL and the target folder path to
 * chrome.storage.sync and tests the connection to the server.
 */

function showStatus(
  element: HTMLElement,
  type: 'info' | 'success' | 'error',
  message: string
): void {
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
  const config = (await chrome.storage.sync.get([
    'serverUrl',
    'folderPath',
    'apiToken',
  ])) as Partial<PopupConfig>;
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
    void (async () => {
      event.preventDefault();

      const serverUrl = serverUrlInput.value.trim();
      const folderPath = folderPathInput.value.trim();
      const apiToken = apiTokenInput.value.trim();

      if (!serverUrl || !folderPath) {
        showStatus(status, 'error', chrome.i18n.getMessage('fillAllFields'));
        return;
      }

      try {
        await chrome.storage.sync.set({
          serverUrl,
          folderPath,
          ...(apiToken.length > 0 ? { apiToken } : {}),
        });
        showStatus(status, 'success', chrome.i18n.getMessage('settingsSaved'));
      } catch (error) {
        showStatus(
          status,
          'error',
          chrome.i18n.getMessage('saveError', [
            error instanceof Error ? error.message : String(error),
          ])
        );
      }
    })();
  });

  // Test connection button handler
  testBtn.addEventListener('click', () => {
    void (async () => {
      const serverUrl = serverUrlInput.value.trim();

      if (!serverUrl) {
        showStatus(status, 'error', chrome.i18n.getMessage('enterServerUrl'));
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = 'Testowanie...';
      showStatus(status, 'info', chrome.i18n.getMessage('testingConnection'));

      try {
        const response = await fetch(`${serverUrl}/health`);
        if (response.ok) {
          const data: unknown = await response.json();
          const statusOk =
            typeof data === 'object' && data !== null && 'status' in data && data.status === 'ok';
          showStatus(
            status,
            statusOk ? 'success' : 'error',
            statusOk
              ? chrome.i18n.getMessage('connectionOk')
              : chrome.i18n.getMessage('connectionBadStatus')
          );
        } else {
          showStatus(
            status,
            'error',
            chrome.i18n.getMessage('httpError', [String(response.status)])
          );
        }
      } catch (error) {
        showStatus(
          status,
          'error',
          chrome.i18n.getMessage('connectionError', [
            error instanceof Error ? error.message : String(error),
          ])
        );
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = chrome.i18n.getMessage('testConnection');
      }
    })();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main());
} else {
  void main();
}
