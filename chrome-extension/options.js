// Options page script

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('optionsForm');
  const serverUrlInput = document.getElementById('serverUrl');
  const folderPathInput = document.getElementById('folderPath');
  const testBtn = document.getElementById('testBtn');
  const status = document.getElementById('status');

  // Load saved settings
  const config = await chrome.storage.sync.get(['serverUrl', 'folderPath']);
  if (config.serverUrl) {
    serverUrlInput.value = config.serverUrl;
  }
  if (config.folderPath) {
    folderPathInput.value = config.folderPath;
  }

  // Form submit handler
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const serverUrl = serverUrlInput.value.trim();
    const folderPath = folderPathInput.value.trim();

    if (!serverUrl || !folderPath) {
      showStatus('error', 'Wypełnij wszystkie pola');
      return;
    }

    try {
      await chrome.storage.sync.set({
        serverUrl: serverUrl,
        folderPath: folderPath,
      });

      showStatus('success', 'Ustawienia zapisane pomyślnie!');
    } catch (error) {
      showStatus('error', `Błąd zapisu: ${error.message}`);
    }
  });

  // Test connection button handler
  testBtn.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim();

    if (!serverUrl) {
      showStatus('error', 'Wprowadź URL serwera');
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testowanie...';
    showStatus('info', 'Testowanie połączenia...');

    try {
      const healthUrl = `${serverUrl}/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.status === 'ok') {
          showStatus('success', 'Połączenie z serwerem działa poprawnie!');
        } else {
          showStatus('error', 'Serwer odpowiedział, ale status nie jest OK');
        }
      } else {
        showStatus('error', `Błąd HTTP: ${response.status}`);
      }
    } catch (error) {
      showStatus('error', `Błąd połączenia: ${error.message}`);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test połączenia';
    }
  });

  function showStatus(type, message) {
    status.className = `status ${type}`;
    status.textContent = message;
    status.style.display = 'block';

    // Hide after 5 seconds for success messages
    if (type === 'success') {
      setTimeout(() => {
        status.style.display = 'none';
      }, 5000);
    }
  }
});
