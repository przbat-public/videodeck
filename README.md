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

