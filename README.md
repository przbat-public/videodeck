# Video Search App

Aplikacja webowa do wyszukiwania i przeglądania filmów pobranych przez yt-dlp. Umożliwia przeszukiwanie opisów i komentarzy, wyświetlanie szczegółowych informacji, odtwarzanie filmów bezpośrednio w przeglądarce oraz zarządzanie kanałami YouTube i kolejką pobierania. Towarzyszące rozszerzenie Chrome pozwala dodawać filmy do kolejki wprost z YouTube.

## Wymagania

- Node.js 22.x
- npm
- Elasticsearch 8.x lub 9.x (lokalnie lub zdalnie)
- Chrome 88+ (tylko dla rozszerzenia Chrome, zob. [chrome-extension/README.md](chrome-extension/README.md))

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

### Chrome extension
- **TypeScript 6** - strict, te same ostre flagi co reszta repo
- **esbuild** - budowanie do klasycznych skryptów MV3 (`background.js`, `content.js`, `popup.js`, `options.js`)
- **Vitest** - testy jednostkowe czystej logiki (framing SSE, postęp yt-dlp, id YouTube)

### Narzędzia
- **ESLint** - linter kodu (z `--max-warnings 0`, patrz [Linting](#linting-i-formatowanie))
- **Prettier** - formatter kodu

## Instalacja

1. Zainstaluj zależności dla backendu, frontendu i rozszerzenia Chrome:

```bash
npm run install:all
```

Lub osobno:

```bash
cd server && npm install
cd ../client && npm install
cd ../chrome-extension && npm install
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

**Foldery na wymiennych dyskach** — zamiast przełączać wiersze przy każdej podmianie dysku, wpisz wzorzec glob. `*` obejmuje jeden segment ścieżki, a za folder kanału uznawany jest katalog zawierający `config.json` lub `*.info.json`:

```
VIDEOS_FOLDER_PATH=/Volumes/*/*
```

Ten jeden wiersz sam znajduje wszystkie kanały na każdym aktualnie zamontowanym woluminie — dysk, którego nie ma, po prostu nie dorzuca folderów (serwer startuje z ostrzeżeniem i łapie foldery, gdy dysk wróci; lista jest odświeżana co kilka sekund). Można mieszać wzorce z literałami (`~/` rozwija się do katalogu domowego):

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/drone-*;/Volumes/MEDIA/*;/Users/<user>/Downloads/youtube/youtube-chrome
```

Opcjonalne zmienne:
```
DOWNLOAD_CONCURRENCY=2   # maks. liczba równoległych pobrań yt-dlp (domyślnie 2, najwyżej jedno na folder)
UPDATE_CONCURRENCY=2     # maks. liczba równoległych aktualizacji metadanych (domyślnie 2, bez limitu na folder)
DOWNLOAD_MAX_ATTEMPTS=3  # ile razy powtórzyć nieudany yt-dlp (backoff 30 s; 429 YouTube itp.)
LOG_LEVEL=info           # poziom logów: info (domyślny), warn, error, silent
OPENAI_API_KEY=sk-REPLACE-ME    # klucz dla AI streszczeń (GET /api/videos/:id/summary)
HOST=127.0.0.1           # adres bindowania serwera (domyślnie loopback)
API_TOKEN=sekret         # bearer token chroniący /api (patrz Bezpieczeństwo niżej)
CORS_ORIGINS=https://example.com  # dodatkowe originy CORS (przecinkami), poza localhost i chrome-extension://
```

**Uwaga:** 
- Jeśli Elasticsearch działa na innym hoście lub porcie, zaktualizuj `ELASTICSEARCH_URL` odpowiednio.
- Jeśli używasz Docker i otrzymujesz błąd "Cannot connect to the Docker daemon", upewnij się że Docker Desktop jest uruchomiony.
- Po pierwszym uruchomieniu serwera, musisz ręcznie wywołać endpoint `/api/videos/refreshCache` aby zindeksować filmy do Elasticsearch (może to potrwać chwilę w zależności od liczby filmów). To samo po aktualizacji, która zmienia analizator wyszukiwania (patrz niżej).

## Bezpieczeństwo

Serwer słucha domyślnie tylko na `127.0.0.1`, a CORS przepuszcza wyłącznie
localne originy (`localhost`/`127.0.0.1`) i rozszerzenia Chrome. Bez
`API_TOKEN` API jest otwarte dla lokalnych procesów, ale żądania przeglądarki
z obcych stron są odrzucane (`Sec-Fetch-Site: cross-site` → 403), więc złośliwa
strona WWW nie wywoła reindeksu ani nie dopisze zadań do kolejki.

Dla zdalnego dostępu ustaw `API_TOKEN` (i ewentualnie `HOST=0.0.0.0` +
`CORS_ORIGINS`): każdy request na `/api` musi wtedy nieść
`Authorization: Bearer <token>`. Rozszerzenie Chrome ma pole „Token API" w
opcjach; `/health` pozostaje publiczne do testów połączenia.

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

**Chrome extension:**
```bash
npm run build:extension   # esbuild → background/content/popup/options.js
```

Wygenerowane pliki `chrome-extension/*.js` nie są commitowane (gitignore) —
po klonowaniu repo rozszerzenie trzeba zbudować przed załadowaniem do Chrome.

### Sprawdzenie typów (bez emisji)

```bash
npm run typecheck                        # wszystkie trzy projekty
cd server && npm run typecheck           # tsconfig.json (kod + testy)
cd client && npm run typecheck           # tsconfig.json + tsconfig.node.json (vite.config.ts)
cd chrome-extension && npm run typecheck # src/ + shared/api.ts (wspólny kontrakt)
```

## Linting i Formatowanie

Projekt używa ESLint i Prettier do utrzymania spójności kodu.

Konfiguracja jest jedna dla całego repozytorium — `eslint.config.mjs` w katalogu
głównym obejmuje `server/`, `client/`, `shared/` i `chrome-extension/src/`
(wygenerowane `*.js` rozszerzenia są ignorowane). Flat config ESLinta lintuje
tylko pliki poniżej swojego katalogu, a `shared/` leży poza oboma
workspace'ami, dlatego lint i formatowanie uruchamia się z roota. Konfiguracja
mówi pluginowi React, że projekt celuje w React 19 (`settings['react-x']`) —
komponenty przyjmują `ref` jako zwykły prop (bez `forwardRef`).

### Sprawdzenie kodu (lint)

```bash
npm run lint
```

Lint działa z `--max-warnings 0`: każdy warning psuje przebieg, więc lista
problemów nie może narastać. Tam, gdzie klucz-w-pozycji jest naprawdę
bezpieczny (np. linie logu yt-dlp, które nigdy nie zmieniają kolejności),
stosowany jest celowy `eslint-disable` z uzasadnieniem.

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

Projekt używa **Jest** dla backendu oraz **Vitest** dla frontendu i rozszerzenia Chrome.

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

**Tylko rozszerzenie Chrome:**
```bash
cd chrome-extension && npm test  # Jednorazowe uruchomienie
cd chrome-extension && npm run test:watch  # Tryb watch
```

**Testy integracyjne z prawdziwym Elasticsearchem** (przepływ reindeksu z
przełączaniem aliasów, składanie diakrytyków, wyszukiwanie po transkryptach —
pomijane w zwykłym `npm test`):
```bash
cd server && npm run test:integration  # wymaga działającego ES (ELASTICSEARCH_URL)
```

**Testy integracyjne z prawdziwym yt-dlp** — szablony argumentów kolejki
pobierania sprawdzane przeciw zainstalowanemu binarium (`--simulate`, bez
pobierania; pomijane w zwykłym `npm test`):
```bash
cd server && npm run test:ytdlp-integration  # wymaga yt-dlp w PATH
```

**Testy property-based (fast-check)** — inwarianty parserów (VTT, SSE,
postęp yt-dlp, id YouTube, runPool) dla dowolnych wejść, z automatycznym
minimalizowaniem kontrprzykładów; po stronie serwera i rozszerzenia.

**Testy end-to-end (Playwright)** — prawdziwa aplikacja (Vite) z zamockowanym
API na poziomie przeglądarki; bez backendu i Elasticsearcha. Scenariusze:
wyszukiwanie sterowane URL, paginacja „Pokaż więcej", strona szczegółów z
odtwarzaczem i napisami, strona statusu:
```bash
npm run test:e2e  # pierwszy raz: cd client && npx playwright install chromium
```

Testy tras serwera sprawdzają odpowiedzi schematami kontraktu (`shared/schemas.ts`),
a parser VTT jest przypięty fixture'ami z prawdziwych plików yt-dlp.

### Pokrycie testami

```bash
# Backend
cd server && npm run test:coverage

# Frontend
cd client && npm run test:coverage
```

Raporty pokrycia są generowane w folderze `coverage/`.

Backend i frontend mają ustawione progi pokrycia (`coverageThreshold` w
`server/jest.config.js`, `test.coverage.thresholds` w `client/vite.config.ts`).
Progi stoją tuż pod aktualnym poziomem — mają wychwytywać regresje, nie być
celem samym w sobie. Kiedy pokrycie rośnie, warto je podnieść. Rozszerzenie
Chrome ma testy jednostkowe bez progów — to niewielka, czysta logika w
`chrome-extension/src/lib/`.

## Dobre praktyki rozwoju

### Architektura
- **Separacja odpowiedzialności** - podział na warstwy: routes, services, utils
- **Zarządzanie stanem** - reducery dla złożonego stanu w React
- **Custom hooks** - reużywalna logika (useVideoSearch, useVideoDetail, useDownloadQueue)
- **Elasticsearch** - indeksowanie i wyszukiwanie filmów z pełnotekstowym wyszukiwaniem i sortowaniem
- **Rekursywne struktury** - zagnieżdżone drzewo komentarzy
- **Toast notifications** - nieinwazyjne komunikaty o sukcesie/błędach (react-hot-toast)
- **Strukturyzowany logger** - `server/src/utils/logger.ts` to jedyne miejsce dotykające `console`; reszta kodu loguje przez niego (poziom + timestamp, `LOG_LEVEL`), a middleware loguje każde żądanie (metoda, ścieżka, status, czas) z korelującym `X-Request-Id` w nagłówku i logach
- **Centralna obsługa błędów** - Express 5 przekazuje odrzucone handlery do jednego middleware'a (`server/src/app.ts`), więc każdy nieobsłużony błąd to spójne 500 w JSON i pełny log z trasą — bez try/catch w każdym handlerze
- **Walidacja kontraktu** - body `POST /api/folder/queue` i `PUT /api/folder/config` parsują schematy zod (`server/src/routes/validation.ts`); błąd walidacji to 400 z pierwszym problemem opisanym wprost
- **Wstrzykiwanie zależności** - `createApp` przyjmuje token i kolejkę pobierania (`createFolderRouter(queue)`), a klient ES ma punkt wstrzykiwania — testy nie sięgają po singleton modułowy
- **Graceful shutdown** - `SIGINT`/`SIGTERM` anuluje zadania kolejki (ubija yt-dlp), zamyka serwer i wymusza exit po 10 s (`server/src/shutdown.ts`)

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

Wszystkie trzy projekty kompiluje TypeScript 6.0 (ta sama wersja, którą Cursor używa do podświetlania błędów). Poza `strict` włączone są:

| Flaga | Skutek w praktyce |
|-------|-------------------|
| `noUncheckedIndexedAccess` | `tablica[0]` i `rekord[klucz]` mają typ `T \| undefined` - trzeba sprawdzić, zanim się użyje |
| `exactOptionalPropertyTypes` | pole `x?: string` można pominąć, ale nie wolno wpisać do niego `undefined`; obiekty z opcjonalnymi polami buduje `stripUndefined()` z `server/src/utils/objectUtils.ts` |
| `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch` | handlery Express kończą się `res.json(...); return;`, nie `return res.json(...)` |
| `noUnusedLocals`, `noUnusedParameters` | nieużywane zmienne to błąd kompilacji (parametry celowo ignorowane zaczynają się od `_`) |
| `verbatimModuleSyntax` (klient, rozszerzenie) | typy importuje się przez `import type`; na serwerze to samo wymusza ESLint (`consistent-type-imports`) |

**Wspólny kontrakt API** leży w `shared/`: schematy zod (`schemas.ts`) to jedyne źródło prawdy o kształtach odpowiedzi, a `api.ts` reeksportuje typy wyprowadzone przez `z.infer` (plus typy żądań i zdarzeń SSE). Serwer, klient i rozszerzenie importują typy jako `@shared/api`; klient **parsuje** każdą odpowiedź schematem (parse, don't trust), a testy tras serwera sprawdzają odpowiedzi tymi samymi schematami — typy i walidacja nie mogą się rozjechać. `api.ts` pozostaje types-only (`import type` wymuszany przez ESLint), a `schemas.ts` i `progress.ts` to celowe moduły runtime'owe wspólne dla serwera i rozszerzenia.

Routery Express używają `RouteHandler<Params, Response>` z `server/src/routes/http.ts`: parametry ścieżki są wyprowadzane z wzorca trasy, `req.body` ma typ `unknown` i jest zawężany helperami `readBody`/`readString`, a `res.json()` przyjmuje tylko typ z kontraktu (albo `ApiError`). `any` jest zabronione lintem (`no-explicit-any: error`) w kodzie i w testach.

## Struktura projektu

```
video-search-app/
├── shared/
│   ├── api.ts           # Typy kontraktu (z schematów) + typy żądań/zdarzeń — types-only
│   ├── schemas.ts       # Schematy zod odpowiedzi API (typy z z.infer) — walidacja klienta i testów
│   ├── progress.ts      # Wspólny parser postępu yt-dlp (serwer + rozszerzenie)
│   └── youtube.ts       # Wspólne wyciąganie id YouTube z URL (serwer + rozszerzenie)
├── server/              # Backend (Node.js/Express)
│   ├── src/
│   │   ├── index.ts     # Start serwera
│   │   ├── app.ts       # Konfiguracja Express (middleware, routery)
│   │   ├── routes/      # Warstwa HTTP — parsowanie żądań, statusy, bez logiki yt-dlp
│   │   │   ├── videos.ts    # Wyszukiwanie, szczegóły, streszczenia, reindeks
│   │   │   ├── folder.ts    # Konfiguracja folderów, list.json, kolejka pobierania
│   │   │   └── http.ts      # RouteHandler, readBody/sendError (narrowery w utils/objectUtils)
│   │   ├── services/    # Logika biznesowa (nie zależy od routes/)
│   │   │   ├── videoScanner.ts
│   │   │   ├── elasticsearchService.ts
│   │   │   ├── downloadQueue.ts  # Kolejka zadań — używa buildYtDlpArgs z ytdlp.ts
│   │   │   ├── ytdlp.ts         # CAŁA rozmowa z yt-dlp: szablony argumentów + spawn
│   │   │   ├── channelList.ts   # Odczyt list.json kanału
│   │   │   ├── folderConfig.ts
│   │   │   └── folderIndex.ts
│   │   ├── utils/       # Narzędzia pomocnicze
│   │   │   ├── commentTreeUtils.ts
│   │   │   ├── logger.ts        # Jedyny moduł dotykający console (poziom + timestamp)
│   │   │   ├── objectUtils.ts   # stripUndefined(), narrowery (isRecord/readString/errnoCode)
│   │   │   └── videoPathUtils.ts
│   │   ├── config.ts    # Konfiguracja (env, glob folderów wideo)
│   │   ├── types.ts     # Typy wewnętrzne serwera (np. VideoInfoJson z yt-dlp)
│   │   └── test-utils.ts    # at()/entry() - pomocniki do testów bez `undefined`
│   ├── tsconfig.json        # Kod + testy (typecheck, IDE)
│   ├── tsconfig.build.json  # Tylko kod produkcyjny (npm run build)
│   └── package.json
├── client/              # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/  # Komponenty React
│   │   │   ├── SearchBar.tsx, VideoCard.tsx, VideoList.tsx
│   │   │   ├── VideoItem.tsx, VideoListSection.tsx
│   │   │   ├── CommentComponent.tsx, VideoComments.tsx, VideoSummary.tsx
│   │   │   └── FolderSection.tsx, FolderConfigEditor.tsx, PlaylistDownloadSection.tsx
│   │   ├── pages/       # Strony aplikacji
│   │   │   ├── StatusPage.tsx        # / - folderów, konfiguracji i kolejki
│   │   │   ├── VideoListPage.tsx     # /videos - wyszukiwarka
│   │   │   └── VideoDetailPage.tsx   # /video/:id - szczegóły + odtwarzacz
│   │   ├── hooks/       # Custom hooks
│   │   │   ├── useVideoSearch.ts, useVideoDetail.ts, useVideoSummary.ts
│   │   │   ├── useDownloadQueue.ts, useCacheRefresh.ts, useRecreateIndices.ts
│   │   │   ├── useCategories.ts, useSearchUrlState.ts
│   │   ├── reducers/    # Zarządzanie stanem
│   │   │   ├── videoSearchReducer.ts, videoDetailReducer.ts, videoSummaryReducer.ts
│   │   │   ├── cacheRefreshReducer.ts, statusReducer.ts, recreateIndicesReducer.ts
│   │   ├── utils/       # searchUrlState.ts, folderConfigForm.ts, videoDates.ts
│   │   ├── test/        # setup Vitest i typowany mock fetch (fetchMock.ts)
│   │   └── App.tsx      # Główny komponent
│   └── package.json
├── chrome-extension/     # Rozszerzenie Chrome (TypeScript + Vitest)
│   ├── src/              # Kod źródłowy (background, content, popup, options)
│   │   └── lib/          # Czysta logika z testami (SSE, postęp, id YouTube)
│   ├── package.json      # npm run build (esbuild) / test (vitest) / typecheck
│   ├── manifest.json     # MV3; wskazuje wygenerowane *.js w katalogu głównym
│   └── *.js              # Build output (nie commitowane)
└── .env                 # Zmienne środowiskowe (nie commituj!)
```

### Chrome extension

Rozszerzenie jest napisane w TypeScript (strict, te same ostre flagi co reszta
repo) i budowane esbuildem do klasycznych skryptów w katalogu głównym
(`chrome-extension/*.js` — nie commitowane, gitignore). Czysta logika —
framing SSE (`feedSseBuffer`/`parseSseEvent`), wyciąganie postępu yt-dlp,
rozpoznawanie id YouTube — leży w `chrome-extension/src/lib/` i ma testy
Vitest. Kontrakt zdarzeń SSE jest współdzielony z serwerem przez
`shared/api.ts` (import `import type`). Komendy:

```bash
npm run build:extension   # esbuild → background/content/popup/options.js
cd chrome-extension && npm test   # testy jednostkowe
cd chrome-extension && npm run typecheck
```

## Funkcjonalności

- **Wyszukiwanie filmów** - wyszukiwanie pełnotekstowe po nazwie pliku, tytule, opisie, transkrypcie napisów i komentarzach z wykorzystaniem Elasticsearch; polskie znaki działają bez diakrytyków (`srodek` = `środek`), sortowanie po trafności lub po polach, wyniki stronicowane („Pokaż więcej")
- **Wsparcie dla wielu folderów** - możliwość skanowania filmów z wielu katalogów jednocześnie
- **Odświeżanie cache** - przycisk "Refresh Cache" do ręcznego reindeksu filmów z dysku, z postępem w toaście; wyszukiwanie działa w trakcie na poprzedniej wersji indeksu
- **Przeładowanie listy** - przycisk "Reload" do przeładowania aktualnie wyświetlanych filmów
- **Lista filmów** - wyświetlanie filmów z miniaturkami (`.webp`)
- **Odtwarzacz wideo** - odtwarzanie filmów w przeglądarce (HTML5 video) z napisami (`<track>` z pobranych `.vtt`)
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
- **Wyszukiwanie w URL** - fraza, sortowanie i kategoria siedzą w adresie strony listy, np. `/videos?q=motor&sort=views-desc&category=fpv`. Taki link można zapisać albo wysłać: po otwarciu formularz i wyniki odzwierciedlają parametry. Wartości domyślne (brak frazy, `date-desc`, wszystkie kategorie) nie trafiają do adresu, a nieznany `sort` wraca do domyślnego. Strona podmienia swój wpis w historii zamiast dokładać nowe, więc "wstecz" wychodzi z listy, a nie cofa filtry.
- **Responsywny design** - dostosowanie do różnych rozmiarów ekranów
- **Rozszerzenie Chrome** - dodawanie filmów do kolejki pobierania wprost z YouTube: wykrywanie wideo na stronie, postęp na żywo (SSE), licznik aktywnych pobrań na ikonie rozszerzenia (szczegóły w [chrome-extension/README.md](chrome-extension/README.md))

## API Endpoints

### GET /health (publiczne)
Readiness probe: pinguje Elasticsearch i zwraca `200 { status: 'ok', elasticsearch: 'ok' }`, a gdy ES nie odpowiada — `503 { status: 'degraded', elasticsearch: 'down' }`. Rozszerzenie Chrome używa go w „Test połączenia".

### GET /metrics (publiczne)
Prometheus: `http_requests_total`, `http_request_duration_ms` (z etykietami method/route/status) i `download_queue_size`.

### GET /api/videos/refreshCache
Odświeża i reindeksuje wszystkie filmy z skonfigurowanych folderów do Elasticsearch.

**Odpowiedź:**
```json
{
  "message": "Cache refresh process started",
  "status": "ok"
}
```

**Cache na wymiennych dyskach.** Indeks każdego folderu żyje w Elasticsearch pod aliasem wyliczanym ze ścieżki folderu i **przeżywa odpięcie dysku** — po podmianie dysku wyszukiwanie od razu używa aliasów aktualnie podpiętych folderów (poprzedni dysk po prostu nie jest przeszukiwany), a strona statusu pokazuje per folder `indeks ES: gotowy / brak`. Zamiast pełnego reindeksu wystarczy wtedy:

```
GET /api/videos/refreshCache?onlyMissing=1
```

— reindeksowane są tylko foldery bez istniejącego indeksu (np. dysk podpięty pierwszy raz); foldery z cache są pomijane i dalej obsługują wyszukiwanie. W web UI służy do tego checkbox **„tylko brakujące (użyj istniejącego indeksu)"** obok przycisku „Odśwież indeks". Pełny reindeks (bez parametru) zostaje dla sytuacji, gdy zawartość dysku się zmieniła i trzeba przebudować istniejący indeks.

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

**Zmiana analizatora wymaga reindeksu:** istniejące indeksy zachowują mappingi
z chwili utworzenia, więc po aktualizacji, która zmienia analizę tekstu (np.
wprowadzenie `polish_folded`), uruchom `GET /api/videos/refreshCache` — nowe
indeksy dostaną nowy analizator, a aliasy przełączą się atomowo.

### GET /api/videos/search
Wyszukuje filmy po frazie w nazwie pliku (`baseName.text^4`), tytule (`^3`), opisie (`^2`), transkrypcie napisów (`transcriptText^2`) i komentarzach (`commentsText`). Tekst jest analizowany z **składaniem znaków diakrytycznych** (customowy analizator `polish_folded`: `standard` + `lowercase` + `asciifolding`), więc `srodek` znajduje `środek` bez wpisywania polskich znaków. Polskie stemming/stopwordy wymagałyby pluginu `analysis-stempel` (nie ma go w domyślnym obrazie Dockera), więc analizator używa wyłącznie wbudowanych komponentów. Transkrypty i komentarze to pola wyłącznie wyszukiwawcze — nigdy nie wracają w odpowiedziach.

**Parametry zapytania:**
- `q` (opcjonalny) - fraza do wyszukania
- `sort` (opcjonalny) - sposób sortowania:
  - `relevance` - po trafności (domyślne zachowanie Elasticsearch, `_score`; sensowne tylko z frazą)
  - `date-desc` - po dacie, najnowsze pierwsze (domyślne)
  - `date-asc` - po dacie, najstarsze pierwsze
  - `views-desc` - po liczbie wyświetleń, malejąco
  - `views-asc` - po liczbie wyświetleń, rosnąco
  - `likes-desc` - po liczbie polubień, malejąco
  - `likes-asc` - po liczbie polubień, rosnąco
- `category` (opcjonalny) - zawęża wyszukiwanie do kanałów z tą kategorią (porównanie bez względu na wielkość liter). `totalCount` dotyczy wtedy samej kategorii. Kategoria, której nie ma w żadnym `config.json`, zwraca zero wyników - nigdy całości.
- `offset` (opcjonalny, domyślnie 0) - pierwszy wynik do zwrócenia (paginacja)
- `limit` (opcjonalny, domyślnie 100, maks. 500) - liczba wyników na stronę

Klient dokłada kolejne strony przyciskiem „Pokaż więcej" dopóki `videos.length < totalCount`.

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

**Kolejka pobierań** działa po stronie serwera (`server/src/services/downloadQueue.ts`): zadania nie są związane z żądaniem HTTP, więc zamknięcie karty nie przerywa `yt-dlp`. Pobrania i aktualizacje mają osobne limity. Pobrań działa równolegle najwyżej `DOWNLOAD_CONCURRENCY` (domyślnie 2) i tylko jedno na folder, bo każde dopisuje do `archive.txt` w tym folderze. Aktualizacji metadanych — najwyżej `UPDATE_CONCURRENCY` (domyślnie 2), także w jednym folderze: każda pisze wyłącznie pod własnym stemem pliku, a odświeżenie indeksu folderu po zadaniu idzie w kolejce per folder, więc równoległe zadania nie nadpisują sobie `.videos-index.json`. Podnosząc ten limit pamiętaj, że każdy proces `yt-dlp` (zwłaszcza z `--write-comments`) to wiele żądań do YouTube z jednego adresu IP; błędy 429 albo prośba o zalogowanie to sygnał, żeby wrócić do mniejszej wartości. Klient odpytuje `GET /api/folder/queue` co 1,5 s, tylko gdy coś jest w kolejce. Kolejka jest trzymana w pamięci — restart serwera ją czyści.

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
  "writeComments": false,
  "extraArgs": ["--cookies-from-browser", "chrome"]
}
```

| Klucz | Domyślnie | Znaczenie |
| --- | --- | --- |
| `channelUrl` | - | Adres kanału; z niego powstaje `list.json` |
| `category` | - | Kategoria kanału (max 64 znaki, jedna linia); pozwala zawężyć wyszukiwanie do jednego tematu |
| `maxHeight` | `2160` | Maksymalna wysokość wideo (144-4320). Preferowany h264/aac w mp4, potem dowolny kodek |
| `subLangs` | `["en"]` | Języki napisów dla `--sub-lang` (`pl`, `en`, `en.*`, `all`). Pusta tablica wyłącza napisy |
| `writeComments` | `true` | Czy pobierać komentarze (`--write-comments`) - są indeksowane do wyszukiwania |
| `extraArgs` | `[]` | Dodatkowe flagi yt-dlp dopisane po wbudowanych, np. `["--cookies-from-browser", "chrome"]` (oddzielne wpisy jak w argv, bez cudzysłowów). Zarezerwowane są flagi, na których opiera się potok: `-f/--format`, `-o/--output`, `-P/--paths`, `--download-archive`, `--no-download-archive`, `--merge-output-format` — `PUT /api/folder/config` je odrzuca, a w ręcznie edytowanym pliku są ignorowane |

Brakujące klucze biorą wartości domyślne (`GET /api/status` zwraca je w `downloadDefaults`). Wartości nieprawidłowe w ręcznie edytowanym pliku są ignorowane, a `PUT /api/folder/config` je odrzuca. Opcje są odczytywane w momencie dodawania zadania do kolejki. Edytor w UI (strona statusu) pozwala je ustawić bez ręcznej edycji pliku.

### Dopisanie napisów w kolejnym języku (bez ponownego pobierania)

Aby dla już pobranego kanału dociągnąć np. polskie napisy obok angielskich:

1. W `config.json` kanału ustaw `subLangs: ["en", "pl"]` i dodaj do `extraArgs`:
   `["--no-write-comments", "--no-write-info-json", "--no-write-thumbnail", "--no-write-description"]`
   — aktualizacje pobiorą wtedy **tylko napisy**: bez komentarzy (najwolniejsza część)
   i bez nadpisywania `info.json` (istniejące komentarze i metadane zostają nietknięte).
2. W sekcji kanału na stronie statusu kliknij **„Aktualizuj wszystkie"** (albo „Aktualizuj stare"
   dla filmów starszych niż miesiąc) — kolejka pobierze nowe pliki `.pl.vtt` pod istniejącymi
   nazwami plików.
3. Nowe napisy są widoczne w odtwarzaczu od razu (endpoint szczegółów czyta pliki `.vtt` z dysku)
   — bez reindeksu. Tempo możesz podnieść zmienną `UPDATE_CONCURRENCY` (domyślnie 2 równoległe).
   Po skończonej akcji wyczyść `extraArgs`, jeśli chcesz wrócić do pełnych aktualizacji.

