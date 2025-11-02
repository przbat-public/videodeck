# Video Search App

Aplikacja webowa do wyszukiwania i przeglądania filmów pobranych przez yt-dlp. Umożliwia przeszukiwanie opisów filmów, wyświetlanie szczegółowych informacji, komentarzy oraz odtwarzanie filmów bezpośrednio w przeglądarce.

## Wymagania

- Node.js 22.x
- npm

## Technologie

### Backend
- **Node.js** + **Express** - serwer HTTP i API REST
- **TypeScript** - typowane rozszerzenie JavaScript
- **Jest** - framework do testowania

### Frontend
- **React** - biblioteka UI
- **TypeScript** - typowane rozszerzenie JavaScript
- **Vite** - narzędzie do budowania i dev server
- **Vitest** - framework do testowania
- **HTML5 Video API** - odtwarzanie filmów

### Narzędzia
- **ESLint** - linter kodu
- **Prettier** - formatter kodu

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

Przykład dla jednego folderu:
```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-channel
```

Przykład dla wielu folderów (oddzielone średnikiem lub przecinkiem):
```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/folder1;/Volumes/MEDIA/folder2;/Volumes/MEDIA/folder3
```
lub
```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/folder1,/Volumes/MEDIA/folder2,/Volumes/MEDIA/folder3
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

## Dobre praktyki rozwoju

### Architektura
- **Separacja odpowiedzialności** - podział na warstwy: routes, services, utils
- **Zarządzanie stanem** - reducery dla złożonego stanu w React
- **Custom hooks** - reużywalna logika (useVideoSearch, useVideoDetail)
- **Cache w pamięci** - buforowanie listy filmów dla wydajności
- **Rekursywne struktury** - zagnieżdżone drzewo komentarzy

### Jakość kodu
- **TypeScript** - silne typowanie w całym projekcie
- **Testy jednostkowe** - wysoka pokrycie testami (Jest + Vitest)
- **Linting** - ESLint do sprawdzania jakości kodu
- **Formatting** - Prettier do spójnego formatowania
- **Walidacja** - sprawdzanie parametrów API i ścieżek plików

### Bezpieczeństwo
- **Path traversal protection** - sanityzacja nazw plików
- **Walidacja ścieżek** - sprawdzanie istnienia plików przed serwowaniem
- **Rozdzielenie środowisk** - osobna konfiguracja dla dev i prod
- **Zmienne środowiskowe** - wrażliwe dane w `.env` (nie commitowane)

## Struktura projektu

```
video-search-app/
├── server/              # Backend (Node.js/Express)
│   ├── src/
│   │   ├── index.ts     # Główny serwer
│   │   ├── routes/      # Endpointy API
│   │   │   └── videos.ts
│   │   ├── services/    # Logika biznesowa
│   │   │   └── videoScanner.ts
│   │   ├── utils/       # Narzędzia pomocnicze
│   │   │   ├── commentTreeUtils.ts
│   │   │   └── videoPathUtils.ts
│   │   ├── config.ts    # Konfiguracja
│   │   └── types.ts     # Definicje typów
│   └── package.json
├── client/              # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/  # Komponenty React
│   │   │   ├── SearchBar.tsx
│   │   │   ├── VideoCard.tsx
│   │   │   ├── VideoList.tsx
│   │   │   └── CommentComponent.tsx
│   │   ├── pages/       # Strony aplikacji
│   │   │   ├── VideoListPage.tsx
│   │   │   └── VideoDetailPage.tsx
│   │   ├── hooks/       # Custom hooks
│   │   │   ├── useVideoSearch.ts
│   │   │   └── useVideoDetail.ts
│   │   ├── reducers/    # Zarządzanie stanem
│   │   │   ├── videoSearchReducer.ts
│   │   │   └── videoDetailReducer.ts
│   │   ├── types.ts     # Definicje typów
│   │   └── App.tsx      # Główny komponent
│   └── package.json
└── .env                 # Zmienne środowiskowe (nie commituj!)
```

## Funkcjonalności

- **Wyszukiwanie filmów** - przeszukiwanie po opisach filmów (pliki `.description`)
- **Wsparcie dla wielu folderów** - możliwość skanowania filmów z wielu katalogów jednocześnie
- **Lista filmów** - wyświetlanie filmów z miniaturkami (`.webp`)
- **Odtwarzacz wideo** - odtwarzanie filmów w przeglądarce (HTML5 video)
- **Szczegóły filmu** - wyświetlanie szczegółowych informacji o filmie:
  - Tytuł i opis
  - Liczba wyświetleń i polubień
  - Data publikacji i czas trwania
  - Nazwa kanału
- **Komentarze** - wyświetlanie komentarzy z zagnieżdżonymi odpowiedziami
  - Rozwijanie/zwijanie długich komentarzy
  - Licznik polubień komentarzy
  - Daty komentarzy z przyjaznym formatowaniem
- **Sortowanie** - sortowanie wyników wyszukiwania:
  - Po dacie (najnowsze/najstarsze)
  - Po liczbie wyświetleń (malejąco/rosnąco)
  - Po liczbie polubień (malejąco/rosnąco)
- **Responsywny design** - dostosowanie do różnych rozmiarów ekranów

## API Endpoints

### GET /api/videos/search
Wyszukuje filmy po frazie w opisach.

**Parametry zapytania:**
- `q` (opcjonalny) - fraza do wyszukania
- `sort` (opcjonalny) - sposób sortowania:
  - `date-desc` - po dacie, najnowsze pierwsze (domyślne)
  - `date-asc` - po dacie, najstarsze pierwsze
  - `views-desc` - po liczbie wyświetleń, malejąco
  - `views-asc` - po liczbie wyświetleń, rosnąco
  - `likes-desc` - po liczbie polubień, malejąco
  - `likes-asc` - po liczbie polubień, rosnąco

**Odpowiedź:**
```json
{
  "videos": [
    {
      "baseName": "nazwa_filmu",
      "title": "Tytuł filmu",
      "description": "Opis...",
      "videoPath": "nazwa_filmu.mp4",
      "thumbnailPath": "nazwa_filmu.webp",
      "uploadDate": "20231201",
      "viewCount": 1000,
      "likeCount": 50,
      "channelName": "Nazwa kanału"
    }
  ]
}
```

### GET /api/videos/file/:filename
Serwuje pliki video (.mp4) i miniaturki (.webp).

**Parametry:**
- `filename` - nazwa pliku (np. `video.mp4`, `thumbnail.webp`)

### GET /api/videos/:baseName/details
Zwraca szczegółowe informacje o filmie wraz z komentarzami.

**Parametry:**
- `baseName` - bazowa nazwa pliku bez rozszerzenia

**Odpowiedź:**
```json
{
  "details": {
    "title": "Tytuł filmu",
    "description": "Pełny opis...",
    "uploadDate": "20231201",
    "duration": "10:30",
    "viewCount": 1000,
    "likeCount": 50,
    "channelName": "Nazwa kanału",
    "comments": [
      {
        "id": "comment_id",
        "author": "Autor komentarza",
        "text": "Treść komentarza",
        "like_count": 10,
        "timestamp": 1701446400,
        "replies": []
      }
    ],
    "commentCount": 25,
    "videoPath": "nazwa_filmu.mp4",
    "thumbnailPath": "nazwa_filmu.webp"
  }
}
```

## Format plików yt-dlp

Aplikacja oczekuje następującej struktury plików w folderze:

```
folder/
├── nazwa_filmu.description      # Opis filmu (wymagany do wyszukiwania)
├── nazwa_filmu.mp4              # Plik wideo
├── nazwa_filmu.webp             # Miniaturka
└── nazwa_filmu.info.json        # Metadane (tytuł, statystyki, komentarze)
```

Aplikacja automatycznie skanuje wszystkie podane foldery i indeksuje pliki spełniające powyższe kryteria.

