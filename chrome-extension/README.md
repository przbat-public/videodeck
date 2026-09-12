# Chrome Extension - Video Downloader

Rozszerzenie Chrome do pobierania wideo z przeglądarki używając endpointu z projektu video-search-app.

## Instalacja

1. Otwórz Chrome i przejdź do `chrome://extensions/`
2. Włącz "Tryb deweloperski" (Developer mode) w prawym górnym rogu
3. Kliknij "Załaduj rozpakowane" (Load unpacked)
4. Wybierz folder `chrome-extension` z tego projektu

## Konfiguracja

1. Kliknij prawym przyciskiem na ikonę rozszerzenia i wybierz "Opcje"
2. Wprowadź:
   - **URL serwera**: URL serwera video-search-app (np. `http://localhost:3001`)
   - **Ścieżka folderu**: Ścieżka do folderu gdzie mają być zapisywane wideo (musi być w `VIDEOS_FOLDER_PATH` środowiska serwera)
3. Kliknij "Test połączenia" aby sprawdzić czy serwer odpowiada
4. Kliknij "Zapisz" aby zapisać ustawienia

## Użycie

1. Otwórz stronę z wideo (np. YouTube)
2. Kliknij na ikonę rozszerzenia w pasku narzędzi
3. Kliknij "Pobierz wideo"
4. Postęp pobierania będzie wyświetlany w popupie

## Funkcje

- Automatyczne wykrywanie wideo na stronie (YouTube, bezpośrednie linki do wideo)
- Pobieranie wideo przez endpoint `/api/folder/download-video`
- Wyświetlanie postępu pobierania w czasie rzeczywistym (SSE)
- Konfiguracja URL serwera i ścieżki folderu

## Wymagania

- Serwer video-search-app musi być uruchomiony
- FolderPath musi być w `VIDEOS_FOLDER_PATH` środowiska serwera
- Serwer musi być dostępny z przeglądarki (CORS musi być skonfigurowany)

## Ikony

Dodaj ikony w folderze `icons/`:
- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

Możesz użyć placeholder ikon lub stworzyć własne.

