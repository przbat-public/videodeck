# Video Search App

Aplikacja webowa do wyszukiwania i przeglądania filmów pobranych przez yt-dlp. Umożliwia przeszukiwanie opisów filmów, wyświetlanie szczegółowych informacji, komentarzy oraz odtwarzanie filmów bezpośrednio w przeglądarce.

## Wymagania

- Node.js 22.x
- npm
- Elasticsearch 8.x lub 9.x (lokalnie lub zdalnie)

## Technologie

### Backend
- **Node.js** + **Express** - serwer HTTP i API REST
- **TypeScript 6** - typowane rozszerzenie JavaScript (ostre flagi, patrz [Typowanie](#typowanie))
- **Elasticsearch** - silnik wyszukiwania i indeksowania filmów
- **Jest** - framework do testowania

### Frontend
- **React** - biblioteka UI
- **TypeScript 6** - typowane rozszerzenie JavaScript
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

2. Uruchom Elasticsearch:

**Opcja A: Docker (zalecane)**

Najpierw upewnij się, że Docker Desktop jest uruchomiony:
- Na macOS: Otwórz aplikację "Docker Desktop" z folderu Applications lub użyj Spotlight (Cmd+Space → "Docker")
- Sprawdź czy Docker działa: `docker ps` (powinno działać bez błędów)

Następnie uruchom Elasticsearch:
```bash
docker run -d -p 9200:9200 -p 9300:9300 -e "discovery.type=single-node" -e "xpack.security.enabled=false" -e "xpack.security.enrollment.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:9.2.0
```

**Opcja B: Homebrew (macOS)**

Jeśli wolisz zainstalować Elasticsearch lokalnie bez Dockera:
```bash
brew install elasticsearch
brew services start elasticsearch
```

**Opcja C: Pobranie i ręczna instalacja**

Zgodnie z [oficjalną dokumentacją Elasticsearch](https://www.elastic.co/guide/en/elasticsearch/reference/current/install-elasticsearch.html).

**Sprawdzenie czy Elasticsearch działa:**
```bash
curl http://localhost:9200
```

Powinieneś zobaczyć odpowiedź JSON z informacjami o Elasticsearch.

3. Skonfiguruj zmienne środowiskowe:

Utwórz plik `.env` w głównym katalogu projektu:

```bash
VIDEOS_FOLDER_PATH=/ścieżka/do/folderu/z/filmami
ELASTICSEARCH_URL=http://localhost:9200
```

Przykład dla jednego folderu:
```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-channel
ELASTICSEARCH_URL=http://localhost:9200
```

Przykład dla wielu folderów (oddzielone średnikiem lub przecinkiem):
```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/folder1;/Volumes/MEDIA/folder2;/Volumes/MEDIA/folder3
ELASTICSEARCH_URL=http://localhost:9200
```

Opcjonalne zmienne:
```
DOWNLOAD_CONCURRENCY=2   # maks. liczba równoległych zadań yt-dlp w kolejce pobierań (domyślnie 2)
```

**Uwaga:** 
- Jeśli Elasticsearch działa na innym hoście lub porcie, zaktualizuj `ELASTICSEARCH_URL` odpowiednio.
- Jeśli używasz Docker i otrzymujesz błąd "Cannot connect to the Docker daemon", upewnij się że Docker Desktop jest uruchomiony.
- Po pierwszym uruchomieniu serwera, musisz ręcznie wywołać endpoint `/api/videos/refreshCache` aby zindeksować filmy do Elasticsearch (może to potrwać chwilę w zależności od liczby filmów).

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

Build używa `server/tsconfig.build.json` (bez testów i `test-utils.ts`). Ponieważ serwer kompiluje też wspólne typy z `shared/`, `rootDir` wskazuje na katalog główny repo i wynik ląduje w `server/dist/server/src/index.js` — `start:prod` i pole `main` w `package.json` już to uwzględniają.

**Frontend:**
```bash
npm run build:client
cd client && npm run preview
```

### Sprawdzenie typów (bez emisji)

```bash
npm run typecheck                # oba projekty
cd server && npm run typecheck   # tsconfig.json (kod + testy)
cd client && npm run typecheck   # tsconfig.json + tsconfig.node.json (vite.config.ts)
```

## Linting i Formatowanie

Projekt używa ESLint i Prettier do utrzymania spójności kodu.

Konfiguracja jest jedna dla całego repozytorium — `eslint.config.mjs` w katalogu
głównym obejmuje `server/`, `client/`, `shared/` i `chrome-extension/`. Flat
config ESLinta lintuje tylko pliki poniżej swojego katalogu, a `shared/` leży
poza oboma workspace'ami, dlatego lint i formatowanie uruchamia się z roota.

### Sprawdzenie kodu (lint)

```bash
npm run lint
```

### Automatyczne naprawianie błędów

```bash
npm run lint:fix
```

### Formatowanie kodu

```bash
npm run format
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

Oba projekty mają ustawione progi pokrycia (`coverageThreshold` w
`server/jest.config.js`, `test.coverage.thresholds` w `client/vite.config.ts`).
Progi stoją tuż pod aktualnym poziomem — mają wychwytywać regresje, nie być
celem samym w sobie. Kiedy pokrycie rośnie, warto je podnieść.

## Dobre praktyki rozwoju

### Architektura
- **Separacja odpowiedzialności** - podział na warstwy: routes, services, utils
- **Zarządzanie stanem** - reducery dla złożonego stanu w React
- **Custom hooks** - reużywalna logika (useVideoSearch, useVideoDetail)
- **Elasticsearch** - indeksowanie i wyszukiwanie filmów z pełnotekstowym wyszukiwaniem i sortowaniem
- **Rekursywne struktury** - zagnieżdżone drzewo komentarzy
- **Toast notifications** - nieinwazyjne komunikaty o sukcesie/błędach (react-hot-toast)

### Jakość kodu
- **TypeScript** - silne typowanie w całym projekcie (szczegóły niżej)
- **Testy jednostkowe** - wysoka pokrycie testami (Jest + Vitest)
- **Linting** - ESLint do sprawdzania jakości kodu
- **Formatting** - Prettier do spójnego formatowania
- **Walidacja** - sprawdzanie parametrów API i ścieżek plików

### Bezpieczeństwo
- **Path traversal protection** - sanityzacja nazw plików
- **Walidacja ścieżek** - sprawdzanie istnienia plików przed serwowaniem
- **Rozdzielenie środowisk** - osobna konfiguracja dla dev i prod
- **Zmienne środowiskowe** - wrażliwe dane w `.env` (nie commitowane)

### Typowanie

Oba projekty kompiluje TypeScript 6.0 (ta sama wersja, którą Cursor używa do podświetlania błędów). Poza `strict` włączone są:

| Flaga | Skutek w praktyce |
|-------|-------------------|
| `noUncheckedIndexedAccess` | `tablica[0]` i `rekord[klucz]` mają typ `T \| undefined` - trzeba sprawdzić, zanim się użyje |
| `exactOptionalPropertyTypes` | pole `x?: string` można pominąć, ale nie wolno wpisać do niego `undefined`; obiekty z opcjonalnymi polami buduje `stripUndefined()` z `server/src/utils/objectUtils.ts` |
| `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch` | handlery Express kończą się `res.json(...); return;`, nie `return res.json(...)` |
| `noUnusedLocals`, `noUnusedParameters` | nieużywane zmienne to błąd kompilacji (parametry celowo ignorowane zaczynają się od `_`) |
| `verbatimModuleSyntax` (tylko klient) | typy importuje się przez `import type`; na serwerze to samo wymusza ESLint (`consistent-type-imports`) |

**Wspólny kontrakt API** leży w `shared/api.ts` - jeden plik z typami odpowiedzi i żądań (`SearchResponse`, `QueueJob`, `StatusResponse`, ...), importowany przez oba projekty jako `@shared/api`. Plik zawiera wyłącznie typy: importy `import type` znikają przy kompilacji, więc ani `node dist/...`, ani bundle Vite nie potrzebują aliasu w runtime. ESLint (`no-restricted-imports`) blokuje zwykły `import` z `@shared/*`, żeby nikt tam przypadkiem nie wrzucił kodu.

Routery Express używają `RouteHandler<Params, Response>` z `server/src/routes/http.ts`: parametry ścieżki są wyprowadzane z wzorca trasy, `req.body` ma typ `unknown` i jest zawężany helperami `readBody`/`readString`, a `res.json()` przyjmuje tylko typ z kontraktu (albo `ApiError`). `any` jest zabronione lintem (`no-explicit-any: error`) w kodzie i w testach.

## Struktura projektu

```
video-search-app/
├── shared/
│   └── api.ts           # Kontrakt HTTP API (tylko typy) wspólny dla serwera i klienta
├── server/              # Backend (Node.js/Express)
│   ├── src/
│   │   ├── index.ts     # Start serwera
│   │   ├── app.ts       # Konfiguracja Express (middleware, routery)
│   │   ├── routes/      # Endpointy API
│   │   │   ├── videos.ts    # Wyszukiwanie, szczegóły, streszczenia, reindeks
│   │   │   ├── folder.ts    # Konfiguracja folderów, list.json, kolejka pobierania
│   │   │   └── http.ts      # RouteHandler, readBody/readString, sendError
│   │   ├── services/    # Logika biznesowa
│   │   │   ├── videoScanner.ts
│   │   │   ├── elasticsearchService.ts
│   │   │   ├── downloadQueue.ts
│   │   │   ├── folderConfig.ts
│   │   │   └── folderIndex.ts
│   │   ├── utils/       # Narzędzia pomocnicze
│   │   │   ├── commentTreeUtils.ts
│   │   │   ├── objectUtils.ts   # stripUndefined() dla exactOptionalPropertyTypes
│   │   │   └── videoPathUtils.ts
│   │   ├── config.ts    # Konfiguracja
│   │   ├── types.ts     # Typy wewnętrzne serwera (np. VideoInfoJson z yt-dlp)
│   │   └── test-utils.ts    # at()/entry() - pomocniki do testów bez `undefined`
│   ├── tsconfig.json        # Kod + testy (typecheck, IDE)
│   ├── tsconfig.build.json  # Tylko kod produkcyjny (npm run build)
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
│   │   │   ├── useVideoDetail.ts
│   │   │   └── useCacheRefresh.ts
│   │   ├── reducers/    # Zarządzanie stanem
│   │   │   ├── videoSearchReducer.ts
│   │   │   ├── videoDetailReducer.ts
│   │   │   └── cacheRefreshReducer.ts
│   │   ├── test/        # setup Vitest i typowany mock fetch (fetchMock.ts)
│   │   └── App.tsx      # Główny komponent
│   └── package.json
└── .env                 # Zmienne środowiskowe (nie commituj!)
```

## Funkcjonalności

- **Wyszukiwanie filmów** - wyszukiwanie pełnotekstowe po nazwie pliku, tytule, opisie i komentarzach z wykorzystaniem Elasticsearch
- **Wsparcie dla wielu folderów** - możliwość skanowania filmów z wielu katalogów jednocześnie
- **Odświeżanie cache** - przycisk "Refresh Cache" do ręcznego reindeksu filmów z dysku, z postępem w toaście; wyszukiwanie działa w trakcie na poprzedniej wersji indeksu
- **Przeładowanie listy** - przycisk "Reload" do przeładowania aktualnie wyświetlanych filmów
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
- **Filtrowanie po kategorii** - każdy kanał ma w swoim `config.json` kategorię (np. `fpv`, `lego`, `psychology`); wybór kategorii zawęża wyszukiwanie do jej kanałów
- **Responsywny design** - dostosowanie do różnych rozmiarów ekranów

## API Endpoints

### GET /api/videos/refreshCache
Odświeża i reindeksuje wszystkie filmy z skonfigurowanych folderów do Elasticsearch.

**Odpowiedź:**
```json
{
  "message": "Cache refresh process started",
  "status": "ok"
}
```

**Uwaga:** Ten endpoint uruchamia proces indeksowania w tle i od razu zwraca odpowiedź. Jeśli reindeks już trwa, zwraca `409` z aktualnym statusem. Postęp można śledzić przez `GET /api/videos/refreshCache/status` (klient robi to sam i pokazuje go w toaście).

### GET /api/videos/refreshCache/status
Stan trwającego (lub ostatniego) reindeksu.

```json
{
  "running": true,
  "startedAt": "2026-09-11T12:37:47.681Z",
  "currentFolder": "/Volumes/MEDIA/example-channel-2",
  "foldersDone": 4,
  "foldersTotal": 56,
  "filesDone": 1018,
  "filesTotal": 2563,
  "indexed": 3285,
  "skipped": 8,
  "errors": []
}
```

`filesDone/filesTotal` dotyczą bieżącego folderu, `indexed/skipped` całego przebiegu. `errors` to lista folderów, których nie udało się zaindeksować (maks. 20 wpisów), `lastError` — ostatni komunikat błędu, a `finishedAt` pojawia się po zakończeniu.

#### Jak działa reindeks

Każdy folder ma w Elasticsearch **alias** `videos_<sha256(folderPath)[:16]>`, który wskazuje na dokładnie jeden fizyczny indeks `videos_<hash>_<timestamp>`. Reindeks:

1. tworzy nowy, pusty indeks fizyczny,
2. czyta `info.json` z dysku i zapisuje dokumenty paczkami (`_bulk`) — najwyżej 50 dokumentów lub ok. 16 MB na żądanie, bo kanały z dziesiątkami tysięcy komentarzy mają `info.json` po 50 MB, a Elasticsearch odrzuca żądania powyżej 100 MB,
3. po zapisaniu całego folderu atomowo przełącza alias na nowy indeks (`_aliases`) i usuwa poprzedni.

Dzięki temu wyszukiwanie działa przez cały czas na starej wersji indeksu, a przerwany reindeks (błąd, restart serwera) nie zostawia pustego indeksu — najwyżej osierocony indeks `videos_<hash>_<timestamp>`, który zostanie usunięty przy następnym udanym reindeksie tego folderu. Filmy o tym samym `videoId` (duplikaty na dysku) trafiają do jednego dokumentu.

Komentarze **nie** są trzymane w ES jako obiekty — tylko jako jedno pole tekstowe `commentsText`, po którym działa wyszukiwanie. Pełne drzewo komentarzy `GET /api/videos/:id/details` czyta z `info.json`. Pole `commentsText` nie jest zwracane w wynikach wyszukiwania.

Po każdym zadaniu z kolejki pobierań (`download`/`update`) zmienione filmy są indeksowane przyrostowo, więc nowy film jest widoczny w wyszukiwaniu bez pełnego reindeksu.

### GET /api/videos/search
Wyszukuje filmy po frazie w nazwie pliku (`baseName^4`), tytule (`^3`), opisie (`^2`) i komentarzach (`commentsText`). Zwraca maks. 100 wyników w podanym sortowaniu.

**Parametry zapytania:**
- `q` (opcjonalny) - fraza do wyszukania
- `sort` (opcjonalny) - sposób sortowania:
  - `date-desc` - po dacie, najnowsze pierwsze (domyślne)
  - `date-asc` - po dacie, najstarsze pierwsze
  - `views-desc` - po liczbie wyświetleń, malejąco
  - `views-asc` - po liczbie wyświetleń, rosnąco
  - `likes-desc` - po liczbie polubień, malejąco
  - `likes-asc` - po liczbie polubień, rosnąco
- `category` (opcjonalny) - zawęża wyszukiwanie do kanałów z tą kategorią (porównanie bez względu na wielkość liter). `totalCount` dotyczy wtedy samej kategorii. Kategoria, której nie ma w żadnym `config.json`, zwraca zero wyników - nigdy całości.

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
      "folderPath": "/ścieżka/do/folderu",
      "uploadDate": "20231201",
      "viewCount": 1000,
      "likeCount": 50,
      "channelName": "Nazwa kanału",
      "comments": []
    }
  ]
}
```

### GET /api/videos/categories
Kategorie zadeklarowane w plikach `config.json` skonfigurowanych folderów - posortowane, bez duplikatów (warianty różniące się wielkością liter są scalane). Zasila listę wyboru w wyszukiwaniu.

```json
{ "categories": ["fpv", "lego", "psychology"] }
```

Kategoria **nie trafia do Elasticsearcha**. Każdy folder ma własny alias indeksu, więc filtr po prostu zawęża listę przeszukiwanych aliasów do folderów z daną kategorią. Dzięki temu `config.json` jest jedynym źródłem prawdy, zmiana kategorii działa od razu i **nie wymaga reindeksu**.

Pliki `config.json` są czytane równolegle, a mapa folder → kategoria jest trzymana w pamięci przez 5 s (`CATEGORY_CACHE_TTL_MS`), bo na zewnętrznym dysku sekwencyjny odczyt 56 plików przy każdym wyszukiwaniu kosztował 0,7–3 s. Zapis przez `PUT /api/folder/config` czyści cache od razu; plik zmieniony ręcznie na dysku jest widoczny po najwyżej 5 s.

### GET /api/videos/file/:filename?folder=<ścieżka>
Serwuje pliki video (.mp4) i miniaturki (.webp).

**Parametry:**
- `filename` - nazwa pliku (np. `video.mp4`, `thumbnail.webp`)
- `folder` (opcjonalny, zalecany) - folder, w którym leży plik; musi być jednym ze skonfigurowanych w `VIDEOS_FOLDER_PATH` (inaczej 403). Bez tego parametru plik jest wyszukiwany po nazwie w Elasticsearch.

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
    "thumbnailPath": "nazwa_filmu.webp",
    "folderPath": "/ścieżka/do/folderu"
  }
}
```

### Pobieranie z YouTube (`/api/folder/*`)

Endpointy do zarządzania folderem kanału (wszystkie wymagają `folderPath` z listy `VIDEOS_FOLDER_PATH`):

| Endpoint | Opis |
| --- | --- |
| `GET /api/status` | Lista folderów i ich `config.json` |
| `PUT /api/folder/config` | Zapis `config.json` (`{ folderPath, config: { channelUrl, category, ... } }`) |
| `POST /api/folder/download-playlist` | `yt-dlp --flat-playlist -j` → `list.json` |
| `GET /api/folder/list-exists?folderPath=` | Czy `list.json` istnieje |
| `GET /api/folder/list?folderPath=` | Zawartość `list.json` + statusy pobrania (z indeksu folderu) |
| `GET /api/folder/video-downloaded?folderPath=&videoId=` | Czy film jest pobrany |
| `POST /api/folder/rebuild-index` | Przebudowa indeksu folderu i `archive.txt` z dysku |
| `POST /api/folder/queue` | Dodanie zadań do kolejki: `{ folderPath, type: "download" \| "update", videos: [{ videoId, videoUrl?, title? }] }` → `202 { jobs, skipped }` |
| `GET /api/folder/queue?folderPath=` | Stan kolejki (`queued/running/done/error/cancelled`, postęp, ogon logu) |
| `DELETE /api/folder/queue/:jobId` | Anulowanie zadania (zabija proces, jeśli trwa) |
| `DELETE /api/folder/queue?folderPath=` | Anulowanie wszystkich zadań folderu |
| `POST /api/folder/download-video` | Pojedyncze pobranie ze strumieniem SSE (używane przez rozszerzenie Chrome); zadanie i tak trafia do kolejki, zamknięcie połączenia nie przerywa pobierania |

**Kolejka pobierań** działa po stronie serwera (`server/src/services/downloadQueue.ts`): zadania nie są związane z żądaniem HTTP, więc zamknięcie karty nie przerywa `yt-dlp`. Równolegle działa maksymalnie `DOWNLOAD_CONCURRENCY` zadań (domyślnie 2) i najwyżej jedno na folder. Klient odpytuje `GET /api/folder/queue` co 1,5 s, tylko gdy coś jest w kolejce. Kolejka jest trzymana w pamięci — restart serwera ją czyści.

**Dwa rodzaje zadań:**
- `download` - pełne pobranie z `--download-archive archive.txt`; film, którego id jest już w `archive.txt`, nie zostanie pobrany drugi raz nawet jeśli zmienił tytuł na YouTube.
- `update` - tylko metadane (`--skip-download`), zapisywane pod **istniejącą** nazwą bazową pliku (`-o "<baseName>.%(ext)s"`), więc `info.json`, opis, miniaturka i napisy są nadpisywane w miejscu, a nie tworzone pod nowym tytułem.

**Indeks folderu** (`server/src/services/folderIndex.ts`): w każdym folderze trzymany jest ukryty plik `.videos-index.json` (`videoId → { baseName, videoFile, infoMtime }`) oraz `archive.txt` yt-dlp. Oba są budowane z dysku przy pierwszym użyciu (czytany jest tylko nagłówek każdego `info.json`) i aktualizowane przyrostowo po każdym zadaniu, dzięki czemu `GET /api/folder/list` nie parsuje już wszystkich `info.json`. Po ręcznym usunięciu plików z folderu wywołaj `POST /api/folder/rebuild-index`.

## Format plików yt-dlp

Aplikacja oczekuje następującej struktury plików w folderze:

```
folder/
├── nazwa_filmu.description      # Opis filmu (wymagany do wyszukiwania)
├── nazwa_filmu.mp4              # Plik wideo
├── nazwa_filmu.webp             # Miniaturka
├── nazwa_filmu.info.json        # Metadane (tytuł, statystyki, komentarze)
├── config.json                  # Konfiguracja kanału i opcje pobierania (patrz niżej)
├── list.json                    # Lista filmów kanału (yt-dlp --flat-playlist)
├── archive.txt                  # Archiwum yt-dlp (youtube <id>) - chroni przed duplikatami
└── .videos-index.json           # Indeks pobranych filmów (generowany automatycznie)
```

Aplikacja automatycznie skanuje wszystkie podane foldery i indeksuje pliki spełniające powyższe kryteria.

### config.json - konfiguracja kanału i opcje pobierania per folder

```json
{
  "channelUrl": "https://www.youtube.com/@kanal",
  "category": "fpv",
  "maxHeight": 1080,
  "subLangs": ["pl", "en"],
  "writeComments": false
}
```

| Klucz | Domyślnie | Znaczenie |
| --- | --- | --- |
| `channelUrl` | - | Adres kanału; z niego powstaje `list.json` |
| `category` | - | Kategoria kanału (max 64 znaki, jedna linia); pozwala zawężyć wyszukiwanie do jednego tematu |
| `maxHeight` | `2160` | Maksymalna wysokość wideo (144-4320). Preferowany h264/aac w mp4, potem dowolny kodek |
| `subLangs` | `["en"]` | Języki napisów dla `--sub-lang` (`pl`, `en`, `en.*`, `all`). Pusta tablica wyłącza napisy |
| `writeComments` | `true` | Czy pobierać komentarze (`--write-comments`) - są indeksowane do wyszukiwania |

Brakujące klucze biorą wartości domyślne (`GET /api/status` zwraca je w `downloadDefaults`). Wartości nieprawidłowe w ręcznie edytowanym pliku są ignorowane, a `PUT /api/folder/config` je odrzuca. Opcje są odczytywane w momencie dodawania zadania do kolejki. Edytor w UI (strona statusu) pozwala je ustawić bez ręcznej edycji pliku.

