# Chrome Extension - Video Downloader

Rozszerzenie Chrome do pobierania wideo z przeglądarki używając endpointu z projektu video-search-app.

## Instalacja

1. Zainstaluj zależności i zbuduj rozszerzenie (kod źródłowy to TypeScript w `src/`, Chrome ładuje wygenerowane `*.js` z katalogu głównego):

   ```bash
   npm install
   npm run build
   ```

2. Otwórz Chrome i przejdź do `chrome://extensions/`
3. Włącz "Tryb deweloperski" (Developer mode) w prawym górnym rogu
4. Kliknij "Załaduj rozpakowane" (Load unpacked)
5. Wybierz folder `chrome-extension` z tego projektu

Po zmianie kodu w `src/` uruchom ponownie `npm run build` i kliknij ikonę odświeżenia przy rozszerzeniu w `chrome://extensions/`.

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
- Pobieranie wideo przez endpoint `/api/folder/download-video` (zadanie trafia do kolejki po stronie serwera — zamknięcie popupu nie przerywa pobierania)
- Wyświetlanie postępu pobierania w czasie rzeczywistym (SSE)
- Lista równoległych pobrań z anulowaniem z poziomu popupu i licznik na ikonie rozszerzenia
- Konfiguracja URL serwera i ścieżki folderu z testem połączenia

## Wymagania

- Chrome 88 lub nowszy (Manifest V3)
- Serwer video-search-app musi być uruchomiony
- FolderPath musi być w `VIDEOS_FOLDER_PATH` środowiska serwera
- Serwer musi być dostępny z przeglądarki (CORS musi być skonfigurowany)

## Rozwój

- Kod źródłowy: `src/*.ts` (TypeScript, strict, te same ostre flagi co reszta
  repo). Czysta logika (parsowanie SSE, wyciąganie postępu, wykrywanie id
  YouTube) leży w `src/lib/` i ma testy jednostkowe (Vitest): `npm test`.
- Kontrakt zdarzeń SSE (`DownloadVideoEvent`) pochodzi ze wspólnego
  `shared/api.ts` — typy są importowane jako `import type`, więc nie trafiają
  do zbudowanego kodu.
- `npm run typecheck` sprawdza typy, `npm run build` generuje `background.js`,
  `content.js`, `popup.js` i `options.js` (wygenerowane pliki nie są
  commitowane). Z katalogu głównego repo działają też `npm run build:extension`,
  `npm run typecheck` i `npm test` (obejmują wszystkie projekty).

## Ikony

Dodaj ikony w folderze `icons/`:
- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

Możesz użyć placeholder ikon lub stworzyć własne.

