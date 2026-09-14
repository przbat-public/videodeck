import { byId } from './lib/dom';
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
  const form = byId<HTMLFormElement>('optionsForm');
  const serverUrlInput = byId<HTMLInputElement>('serverUrl');
  const folderPathInput = byId<HTMLInputElement>('folderPath');
  const testBtn = byId<HTMLButtonElement>('testBtn');
  const status = byId('status');

  // Load saved settings
  const config = (await chrome.storage.sync.get([
    'serverUrl',
    'folderPath',
  ])) as Partial<PopupConfig>;
  if (config.serverUrl) {
    serverUrlInput.value = config.serverUrl;
  }
  if (config.folderPath) {
    folderPathInput.value = config.folderPath;
  }

  // Form submit handler
  form.addEventListener('submit', (event) => {
    void (async () => {
      event.preventDefault();

      const serverUrl = serverUrlInput.value.trim();
      const folderPath = folderPathInput.value.trim();

      if (!serverUrl || !folderPath) {
        showStatus(status, 'error', 'Wypełnij wszystkie pola');
        return;
      }

      try {
        await chrome.storage.sync.set({ serverUrl, folderPath });
        showStatus(status, 'success', 'Ustawienia zapisane pomyślnie!');
      } catch (error) {
        showStatus(
          status,
          'error',
          `Błąd zapisu: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  });

  // Test connection button handler
  testBtn.addEventListener('click', () => {
    void (async () => {
      const serverUrl = serverUrlInput.value.trim();

      if (!serverUrl) {
        showStatus(status, 'error', 'Wprowadź URL serwera');
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = 'Testowanie...';
      showStatus(status, 'info', 'Testowanie połączenia...');

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
              ? 'Połączenie z serwerem działa poprawnie!'
              : 'Serwer odpowiedział, ale status nie jest OK'
          );
        } else {
          showStatus(status, 'error', `Błąd HTTP: ${response.status}`);
        }
      } catch (error) {
        showStatus(
          status,
          'error',
          `Błąd połączenia: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test połączenia';
      }
    })();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main());
} else {
  void main();
}
