# Video Search App

Aplikacja webowa do wyszukiwania filmów pobranych przez yt-dlp. Umożliwia przeszukiwanie opisów filmów i ich odtwarzanie.

## Wymagania

- Node.js 22.x
- npm

## Instalacja

1. Zainstaluj zależności dla backendu i frontendu:

```bash
npm run install:all
```

Lub osobno:

```bash
cd server && npm install
cd ../client && npm install
```

2. Skonfiguruj zmienną środowiskową:

Utwórz plik `.env` w głównym katalogu projektu:

```bash
VIDEOS_FOLDER_PATH=/ścieżka/do/folderu/z/filmami
```

Przykład:
```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-channel
```

## Uruchomienie

### Development mode

W dwóch osobnych terminalach:

**Terminal 1 - Backend:**
```bash
npm run dev:server
```

Serwer backend będzie dostępny na `http://localhost:3001`

**Terminal 2 - Frontend:**
```bash
npm run dev:client
```

Aplikacja frontendowa będzie dostępna na `http://localhost:3000`

### Production build

**Backend:**
```bash
npm run build:server
cd server && npm run start:prod
```

**Frontend:**
```bash
npm run build:client
cd client && npm run preview
```

## Linting i Formatowanie

Projekt używa ESLint i Prettier do utrzymania spójności kodu.

### Sprawdzenie kodu (lint)

**Wszystkie projekty:**
```bash
npm run lint
```

**Tylko backend:**
```bash
cd server && npm run lint
```

**Tylko frontend:**
```bash
cd client && npm run lint
```

### Automatyczne naprawianie błędów

**Wszystkie projekty:**
```bash
npm run lint:fix
```

**Tylko backend:**
```bash
cd server && npm run lint:fix
```

**Tylko frontend:**
```bash
cd client && npm run lint:fix
```

### Formatowanie kodu

**Wszystkie projekty:**
```bash
npm run format
```

**Tylko backend:**
```bash
cd server && npm run format
```

**Tylko frontend:**
```bash
cd client && npm run format
```

### Sprawdzenie formatowania (bez zmiany plików)

```bash
npm run format:check
```

## Testy

Projekt używa **Jest** dla backendu i **Vitest** dla frontendu.

### Uruchamianie testów

**Wszystkie projekty:**
```bash
npm test
```

**Tylko backend:**
```bash
cd server && npm test
cd server && npm run test:watch  # Tryb watch
cd server && npm run test:coverage  # Z raportem pokrycia
```

**Tylko frontend:**
```bash
cd client && npm test  # Tryb watch
cd client && npm run test:run  # Jednorazowe uruchomienie
cd client && npm run test:ui  # Interfejs graficzny
cd client && npm run test:coverage  # Z raportem pokrycia
```

### Pokrycie testami

```bash
# Backend
cd server && npm run test:coverage

# Frontend
cd client && npm run test:coverage
```

Raporty pokrycia są generowane w folderze `coverage/`.

## Struktura projektu

```
node-project-1/
├── server/              # Backend (Node.js/Express)
│   ├── src/
│   │   ├── index.ts     # Główny serwer
│   │   ├── routes/      # Endpointy API
│   │   ├── services/    # Logika biznesowa
│   │   └── config.ts    # Konfiguracja
│   └── package.json
├── client/              # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/  # Komponenty React
│   │   ├── hooks/       # Custom hooks
│   │   └── App.tsx      # Główny komponent
│   └── package.json
└── .env                 # Zmienne środowiskowe (nie commituj!)
```

## Funkcjonalności

- Wyszukiwanie filmów po opisach (pliki `.description`)
- Wyświetlanie listy filmów z miniaturkami (`.webp`)
- Odtwarzanie filmów w przeglądarce (HTML5 video)
- Responsywny design

## API Endpoints

### GET /api/videos/search?q={query}
Wyszukuje filmy po frazie w opisach.

### GET /api/videos/list
Zwraca listę wszystkich filmów w folderze.

### GET /api/videos/file/:filename
Serwuje pliki video (.mp4) i miniaturki (.webp).

## Format plików yt-dlp

Aplikacja oczekuje następującej struktury plików w folderze:

```
folder/
├── nazwa_filmu.description
├── nazwa_filmu.mp4
├── nazwa_filmu.webp
└── nazwa_filmu.info.json
```

## Bezpieczeństwo

- Walidacja ścieżek folderów
- Sanityzacja nazw plików (zapobieganie path traversal)
- Sprawdzanie istnienia plików przed serwowaniem

