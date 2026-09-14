# Instrukcja instalacji rozszerzenia Chrome

## Krok 0: Zbuduj rozszerzenie (wymagane)

Kod źródłowy rozszerzenia to TypeScript w folderze `src/`. Chrome ładuje
wygenerowane pliki `*.js`, więc przed pierwszą instalacją (i po każdej zmianie
kodu):

```bash
cd chrome-extension
npm install
npm run build
```

## Krok 1: Wygeneruj ikony (opcjonalne, ale zalecane)

### Opcja A: Użyj create-icons.html (najłatwiejsze)

1. Otwórz plik `create-icons.html` w przeglądarce Chrome
2. Ikony zostaną automatycznie pobrane do folderu Pobrane
3. Przenieś pobrane pliki (`icon16.png`, `icon48.png`, `icon128.png`) do folderu `chrome-extension/icons/`

### Opcja B: Stwórz własne ikony

- Użyj dowolnego edytora grafiki (GIMP, Photoshop, Figma)
- Stwórz ikony w rozmiarach: 16x16, 48x48, 128x128 pikseli
- Zapisz jako PNG w folderze `chrome-extension/icons/` jako `icon16.png`, `icon48.png`, `icon128.png`

**Uwaga:** Jeśli nie dodasz ikon, Chrome użyje domyślnej ikony, ale rozszerzenie będzie działać.

## Krok 2: Zainstaluj rozszerzenie

1. **Otwórz Chrome** i przejdź do strony zarządzania rozszerzeniami:

   ```
   chrome://extensions/
   ```

   Lub:
   - Kliknij menu Chrome (trzy kropki w prawym górnym rogu)
   - Wybierz **Rozszerzenia** → **Zarządzaj rozszerzeniami**

2. **Włącz tryb deweloperski:**
   - W prawym górnym rogu znajdź przełącznik **"Tryb deweloperski"** (Developer mode)
   - Przełącz go na **WŁĄCZONE** (ON)

3. **Załaduj rozszerzenie:**
   - Kliknij przycisk **"Załaduj rozpakowane"** (Load unpacked) lub **"Wczytaj bez pakowania"**
   - W oknie wyboru folderu przejdź do:
     ```
     /Users/<user>/Projects/video-search-app/chrome-extension
     ```
   - Wybierz folder `chrome-extension` i kliknij **"Wybierz"** (Select)

4. **Sprawdź instalację:**
   - Rozszerzenie powinno pojawić się na liście
   - Ikona rozszerzenia powinna pojawić się w pasku narzędzi Chrome (obok adresu URL)

## Krok 3: Skonfiguruj rozszerzenie

1. **Otwórz opcje:**
   - Kliknij prawym przyciskiem myszy na ikonę rozszerzenia w pasku narzędzi
   - Wybierz **"Opcje"** (Options)

   LUB:

   - Przejdź do `chrome://extensions/`
   - Znajdź rozszerzenie "Video Downloader"
   - Kliknij **"Szczegóły"** (Details)
   - Kliknij **"Opcje rozszerzenia"** (Extension options)

2. **Wprowadź ustawienia:**
   - **URL serwera:** Wprowadź URL serwera video-search-app
     - Przykład: `http://localhost:3001`
     - Upewnij się, że serwer jest uruchomiony!

   - **Ścieżka folderu:** Wprowadź ścieżkę do folderu gdzie mają być zapisywane wideo
     - Przykład: `/Users/<user>/Videos/youtube`
     - **WAŻNE:** Ta ścieżka musi być w zmiennej środowiskowej `VIDEOS_FOLDER_PATH` serwera!

   - **Token API (opcjonalny):** Wypełnij tylko, gdy serwer ma ustawione
     `API_TOKEN` — podaj tę samą wartość (wysyłana jako `Authorization: Bearer`).

3. **Przetestuj połączenie:**
   - Kliknij przycisk **"Test połączenia"**
   - Jeśli wszystko działa, zobaczysz komunikat: "Połączenie z serwerem działa poprawnie!"
   - Jeśli widzisz błąd, sprawdź:
     - Czy serwer jest uruchomiony
     - Czy URL jest poprawny
     - Czy serwer ma włączony CORS

4. **Zapisz ustawienia:**
   - Kliknij przycisk **"Zapisz"**
   - Zobaczysz komunikat potwierdzający zapis

## Krok 4: Użyj rozszerzenia

1. **Otwórz stronę z wideo:**
   - Przejdź na YouTube lub inną stronę z wideo
   - Przykład: `https://www.youtube.com/watch?v=VIDEO_ID`

2. **Kliknij ikonę rozszerzenia:**
   - W pasku narzędzi Chrome kliknij ikonę rozszerzenia
   - Powinieneś zobaczyć popup z informacjami o wideo

3. **Pobierz wideo:**
   - Kliknij przycisk **"Pobierz wideo"**
   - Postęp pobierania będzie wyświetlany w popupie
   - Po zakończeniu zobaczysz komunikat sukcesu

## Rozwiązywanie problemów

### Rozszerzenie nie pojawia się na liście

- Sprawdź czy wybrałeś właściwy folder (`chrome-extension`, nie jego zawartość)
- Sprawdź czy `manifest.json` jest w folderze `chrome-extension`

### Błąd "Nie można załadować rozszerzenia"

- Sprawdź konsolę błędów w `chrome://extensions/` (kliknij "Szczegóły" → "Błędy")
- Upewnij się, że wszystkie pliki są obecne
- Sprawdź czy `manifest.json` jest poprawny

### "Nie znaleziono wideo na tej stronie"

- Upewnij się, że jesteś na stronie z wideo (np. YouTube)
- Odśwież stronę i spróbuj ponownie
- Sprawdź czy content script jest załadowany (DevTools → Console)

### Błąd połączenia z serwerem

- Sprawdź czy serwer jest uruchomiony
- Sprawdź czy URL serwera jest poprawny
- Sprawdź czy serwer ma włączony CORS (powinien mieć `app.use(cors())`)
- Sprawdź czy folderPath jest w `VIDEOS_FOLDER_PATH` serwera

### Pobieranie nie działa

- Sprawdź czy serwer ma zainstalowany `yt-dlp`
- Sprawdź logi serwera w terminalu
- Sprawdź czy folderPath istnieje i ma odpowiednie uprawnienia

## Wymagania

- Chrome w wersji 88 lub nowszej (dla Manifest V3)
- Serwer video-search-app musi być uruchomiony
- FolderPath musi być w `VIDEOS_FOLDER_PATH` środowiska serwera
- Serwer musi mieć włączony CORS
