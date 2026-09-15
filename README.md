# Video Search App

[![CI](https://github.com/przbat-public/videodeck/actions/workflows/ci.yml/badge.svg)](https://github.com/przbat-public/videodeck/actions/workflows/ci.yml)
[![CodeQL](https://github.com/przbat-public/videodeck/actions/workflows/codeql.yml/badge.svg)](https://github.com/przbat-public/videodeck/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/przbat-public/videodeck)](https://github.com/przbat-public/videodeck/releases)

A self-hosted web app for searching and browsing YouTube videos downloaded with yt-dlp: an Elasticsearch full-text index over titles, descriptions, comments, and transcripts, an in-browser player with multi-language subtitles, per-channel download configuration, and a server-side yt-dlp queue — plus a companion Chrome extension for enqueueing videos straight from YouTube.

## Screenshots

<p align="center">
  <img src="docs/screenshots/search.png" alt="Search with filters" width="48%">
  <img src="docs/screenshots/status.png" alt="Channel status page" width="48%">
  <img src="docs/screenshots/detail.png" alt="Video player with subtitles" width="48%">
</p>

> Polish documentation: [docs/README.pl.md](docs/README.pl.md)

## Requirements

- Node.js 22.x
- npm
- Elasticsearch 8.x or 9.x (local or remote)
- Chrome 88+ (only for the Chrome extension; see [chrome-extension/README.md](chrome-extension/README.md))

## Technologies

### Backend

- **Node.js** + **Express** - HTTP server and REST API
- **TypeScript 6** - typed extension of JavaScript (strict flags; see [Typing](#typing))
- **Elasticsearch** - search and indexing engine for videos
- **Jest** - testing framework

### Frontend

- **React** - UI library
- **TypeScript 6** - typed extension of JavaScript
- **Vite** - build tool and dev server
- **Vitest** - testing framework
- **HTML5 Video API** - video playback

### Chrome extension

- **TypeScript 6** - strict, the same strict flags as the rest of the repo
- **esbuild** - building to classic MV3 scripts (`background.js`, `content.js`, `popup.js`, `options.js`)
- **Vitest** - unit tests for pure logic (SSE framing, yt-dlp progress, YouTube id)

### Tools

- **Biome** - code formatter and linter (strict rule set; see [Linting](#linting-and-formatting))
- **ESLint** - type-aware lint (`--max-warnings 0`; see [Linting](#linting-and-formatting))

## Installation

1. Install dependencies for the backend, frontend, and Chrome extension:

```bash
npm run install:all
```

Or separately:

```bash
cd server && npm install
cd ../client && npm install
cd ../chrome-extension && npm install
```

2. Start Elasticsearch:

**Option A: Docker (recommended)**

First make sure Docker Desktop is running:

- On macOS: open the "Docker Desktop" app from the Applications folder or use Spotlight (Cmd+Space → "Docker")
- Check that Docker works: `docker ps` (should run without errors)

Then start Elasticsearch (ports bound to loopback — without a password, ES must not be reachable from the network):

```bash
docker run -d -p 127.0.0.1:9200:9200 -p 127.0.0.1:9300:9300 -e "discovery.type=single-node" -e "xpack.security.enabled=false" -e "xpack.security.enrollment.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:9.2.0
```

**Option B: Homebrew (macOS)**

If you prefer to install Elasticsearch locally without Docker:

```bash
brew install elasticsearch
brew services start elasticsearch
```

**Option C: Download and manual installation**

Per the [official Elasticsearch documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/install-elasticsearch.html).

**Checking whether Elasticsearch is running:**

```bash
curl http://localhost:9200
```

You should see a JSON response with information about Elasticsearch.

3. Configure environment variables:

Create a `server/.env` file (the server loads it from its own directory —
`dotenv.config()` runs with cwd=`server/`; a root-level `.env` is ignored):

```bash
VIDEOS_FOLDER_PATH=/path/to/videos/folder
ELASTICSEARCH_URL=http://localhost:9200
```

Example for a single folder:

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-channel
ELASTICSEARCH_URL=http://localhost:9200
```

Example for multiple folders (separated by semicolon or comma):

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/folder1;/Volumes/MEDIA/folder2;/Volumes/MEDIA/folder3
ELASTICSEARCH_URL=http://localhost:9200
```

**Folders on removable drives** — instead of swapping lines each time you swap the drive, use a glob pattern. `*` matches one path segment, and a directory containing `config.json` or `*.info.json` is treated as a channel folder:

```
VIDEOS_FOLDER_PATH=/Volumes/*/*
```

This single line finds all channels on every currently mounted volume on its own — a drive that is absent simply contributes no folders (the server starts with a warning and picks the folders up when the drive comes back; the list is refreshed every few seconds). You can mix patterns with literals (`~/` expands to the home directory):

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-*;/Volumes/MEDIA/*;/Users/<user>/Downloads/youtube/youtube-chrome
```

Optional variables:

```
DOWNLOAD_CONCURRENCY=2      # max. number of parallel yt-dlp downloads (default 2, at most one per folder)
UPDATE_CONCURRENCY=2        # max. number of parallel metadata updates (default 2, no per-folder limit)
DOWNLOAD_MAX_ATTEMPTS=3     # how many times to retry a failed yt-dlp (30 s backoff; YouTube 429 etc.)
LOG_LEVEL=info              # log level: info (default), warn, error, silent
OPENAI_API_KEY=sk-REPLACE-ME  # key for AI summaries (GET /api/videos/:id/summary)
HOST=127.0.0.1              # server bind address (defaults to loopback)
API_TOKEN=secret            # bearer token protecting /api (see Security below)
CORS_ORIGINS=https://example.com  # extra CORS origins (comma-separated), beyond localhost and chrome-extension://
ALLOWED_HOSTS=nas.local,192.168.0.10  # extra hostnames/IPs allowed in the Host header (needed with HOST=0.0.0.0)
EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnop  # exact extension id allowed by CORS (without it: any chrome-extension://)
RATE_LIMIT_MAX=2000         # HTTP request limit per time window per IP (default 2000)
RATE_LIMIT_WINDOW_MS=600000 # rate-limit window length in ms (default 10 minutes)
```

**Note:**

- If Elasticsearch runs on a different host or port, update `ELASTICSEARCH_URL` accordingly.
- If you use Docker and get a "Cannot connect to the Docker daemon" error, make sure Docker Desktop is running.
- After starting the server for the first time, you must manually call the `/api/videos/refreshCache` endpoint to index videos into Elasticsearch (this may take a while depending on the number of videos). The same applies after an upgrade that changes the search analyzer (see below).
- **Keep yt-dlp up to date** — YouTube regularly breaks older versions. yt-dlp recommends the `nightly` channel (stable tends to be "stale and prone to external breakage"); the version is shown in the server startup log (`yt-dlp version: ...`), and when downloads start failing with "Sign in to confirm you're not a bot"/429 errors, the first thing to try is `yt-dlp -U` or the `nightly` channel. In a channel's `config.json` you can also enable `impersonate: true` (browser impersonation, without cookies).

## Security

The server listens on `127.0.0.1` only by default, and CORS allows only
local origins (`localhost`/`127.0.0.1`) and Chrome extensions. Without
`API_TOKEN`, the API is open to local processes, but browser requests
from foreign pages are rejected (`Sec-Fetch-Site: cross-site` → 403), so a
malicious website cannot trigger a reindex or enqueue jobs.

Additional protections:

- **Host allowlist (DNS rebinding)** — the server only accepts a `Host`
  header from loopback (`localhost`, `127.0.0.1`, `[::1]`) or from
  `ALLOWED_HOSTS`. An attacker's domain that resolves to 127.0.0.1 sends
  its own `Host` and gets a 403 before it reaches the API.
- **SSRF via video URL** — `POST /api/folder/queue` and `/api/folder/download-video`
  accept only YouTube URLs (recognized by `shared/youtube.ts`);
  any other URL (including `file://` or IP addresses) is rejected, and yt-dlp
  always receives the canonical `https://www.youtube.com/watch?v=<id>`.
- **Forbidden yt-dlp flags** — `extraArgs` in `config.json` will not pass
  through `--exec`, `--config-locations`, `--cookies`/`--load-cookies`/
  `--cookies-from-browser`, `--proxy`, `--netrc`, `--username`, `--password`,
  or `--video-password` (RCE, cookie theft, credential leaks).
  `PUT /api/folder/config` rejects these flags, and in a hand-edited file
  they are ignored (together with their value).
- **Exact extension id in CORS** — by default (dev mode), CORS allows
  any `chrome-extension://…` because developer extensions get a new id
  each time they are loaded. Set `EXTENSION_ORIGINS` with the exact id
  (visible on `chrome://extensions`) so that the API is only called by
  your extension.

For remote access, set `API_TOKEN` (and optionally `HOST=0.0.0.0` +
`ALLOWED_HOSTS` + `CORS_ORIGINS`): every request to `/api` must then carry
`Authorization: Bearer <token>`. The Chrome extension has a „Token API"
("API token") field in its options; `/health` stays public for connection
tests.

## Internationalization (Polish / English)

- **Client** (`client/src/i18n/`): react-i18next with `locales/pl.json`
  and `en.json` catalogs — all UI strings (pages, components, toasts, reindex
  progress, job statuses) go through `t()` with typed keys (a typo in a key
  is a TypeScript error). Polish is the default and fallback language;
  the PL/EN switcher in the top-right corner saves the choice to localStorage.
  Pluralization uses i18next rules (pl: 1 film / 2 filmy / 5 filmów).
- **Chrome extension** (`chrome-extension/_locales/{pl,en}/messages.json`):
  native `chrome.i18n` — `default_locale: "pl"` in the manifest,
  `chrome.i18n.getMessage` in the code, and the static HTML is translated via
  `[data-i18n]` (`src/lib/i18n.ts`). The extension follows the browser
  language (fallback: Polish).
- **Server**: API messages stay in English (stable for logs and
  tests); the client adds its own translated error prefixes.

A new key is added in `pl.json`, `en.json` (optionally in the extension's
`messages.json`); client keys are type-checked, so an inconsistency surfaces
in typecheck. Client tests run with the default Polish; E2E checks
language switching in both directions.

## Running

### Development mode

In two separate terminals:

**Terminal 1 - Backend:**

```bash
npm run dev:server
```

The backend server will be available at `http://localhost:3001`

**Terminal 2 - Frontend:**

```bash
npm run dev:client
```

The frontend app will be available at `http://localhost:3000`

### Production build

**Backend:**

```bash
npm run build:server
cd server && npm run start:prod
```

The build uses `server/tsconfig.build.json` (without tests and `test-utils.ts`). Because the server also compiles the shared types from `shared/`, `rootDir` points at the repo root and the output lands in `server/dist/server/src/index.js` — `start:prod` and the `main` field in `package.json` already account for this.

**Frontend:**

```bash
npm run build:client
cd client && npm run preview
```

**Chrome extension:**

```bash
npm run build:extension   # esbuild → background/content/popup/options.js
```

The generated `chrome-extension/*.js` files are not committed (gitignore) —
after cloning the repo, the extension must be built before loading it into
Chrome.

### Type checking (no emit)

```bash
npm run typecheck                        # all three projects
cd server && npm run typecheck           # tsconfig.json (code + tests)
cd client && npm run typecheck           # tsconfig.json + tsconfig.node.json (vite.config.ts)
cd chrome-extension && npm run typecheck # src/ + shared/api.ts (shared contract)
```

## Linting and Formatting

The project uses Biome (formatter + linter) and ESLint (type-aware rules)
to keep the code consistent.

Biome's `biome.json` in the root directory is the single source of truth for
formatting (single quotes, line width 120) and for the strict lint rules
(`noExplicitAny`, `noNonNullAssertion`, cognitive complexity ≤ 15,
`noConsole`, …). ESLint's flat config (`eslint.config.mjs`) covers `server/`,
`client/`, `shared/`, and `chrome-extension/src/` (the generated `*.js` files
of the extension are ignored) and carries only the rules Biome cannot —
type-aware TypeScript checks, React hooks and Playwright. Flat config only
lints files below its own directory, and `shared/` sits outside both
workspaces, which is why lint and formatting are run from the root. The
configuration tells the React plugin that the project targets React 19
(`settings['react-x']`) — components accept `ref` as a regular prop (without
`forwardRef`).

### Checking the code (lint)

```bash
npm run lint          # biome check + repository-invariant scripts
npm run lint:types    # eslint --max-warnings 0 (type-aware, React, Playwright)
```

Lint runs with zero tolerance: every warning fails the run, so the list of
issues cannot grow. Where an indexed access is genuinely safe (e.g. yt-dlp
log lines that never change order), a deliberate `eslint-disable` with
justification is used.

### Auto-fixing errors

```bash
npm run lint:fix
```

### Code formatting

```bash
npm run format
```

### Checking formatting (without changing files)

```bash
npm run format:check
```

## Tests

The project uses **Jest** for the backend and **Vitest** for the frontend and the Chrome extension.

### Running tests

**All projects:**

```bash
npm test
```

**Backend only:**

```bash
cd server && npm test
cd server && npm run test:watch  # Watch mode
cd server && npm run test:coverage  # With coverage report
```

**Frontend only:**

```bash
cd client && npm test  # Watch mode
cd client && npm run test:run  # One-off run
cd client && npm run test:ui  # Graphical interface
cd client && npm run test:coverage  # With coverage report
```

**Chrome extension only:**

```bash
cd chrome-extension && npm test  # One-off run
cd chrome-extension && npm run test:watch  # Watch mode
```

**Integration tests with a real Elasticsearch** (reindex flow with
alias switching, diacritic folding, searching transcripts —
skipped in the regular `npm test`):

```bash
cd server && npm run test:integration  # requires a running ES (ELASTICSEARCH_URL)
```

**Integration tests with a real yt-dlp** — download-queue argument templates
checked against the installed binary (`--simulate`, without
downloading; skipped in the regular `npm test`):

```bash
cd server && npm run test:ytdlp-integration  # requires yt-dlp on PATH
```

**Property-based tests (fast-check)** — parser invariants (VTT, SSE,
yt-dlp progress, YouTube id, runPool) for arbitrary inputs, with automatic
minimization of counterexamples; on the server and extension side.

**End-to-end tests (Playwright)** — the real app (Vite) with the API mocked
at the browser level; no backend and no Elasticsearch. Scenarios:
URL-driven search, „Pokaż więcej" ("Show more") pagination, the details page
with the player and subtitles, the status page:

```bash
npm run test:e2e  # first time: cd client && npx playwright install chromium
```

Server route tests check responses against contract schemas (`shared/schemas.ts`),
and the VTT parser is pinned by fixtures from real yt-dlp files.

### Test coverage

```bash
# Backend
cd server && npm run test:coverage

# Frontend
cd client && npm run test:coverage
```

Coverage reports are generated in the `coverage/` folder.

The backend and frontend have coverage thresholds configured (`coverageThreshold` in
`server/jest.config.js`, `test.coverage.thresholds` in `client/vite.config.ts`).
The thresholds sit just below the current level — they are meant to catch
regressions, not to be a goal in themselves. When coverage grows, it is worth
raising them. The Chrome extension has unit tests without thresholds — it is
small, pure logic in `chrome-extension/src/lib/`.

## Development best practices

### Architecture

- **Separation of concerns** - layered structure: routes, services, utils
- **State management** - reducers for complex state in React
- **Custom hooks** - reusable logic (useVideoSearch, useVideoDetail, useDownloadQueue)
- **Elasticsearch** - indexing and searching videos with full-text search and sorting
- **Recursive structures** - nested comment tree
- **Toast notifications** - unobtrusive success/error messages (react-hot-toast)
- **Structured logger** - `server/src/utils/logger.ts` is the only place that touches `console`; the rest of the code logs through it (level + timestamp, `LOG_LEVEL`), and the middleware logs every request (method, path, status, time) with a correlating `X-Request-Id` in the header and logs
- **Central error handling** - Express 5 forwards rejected handlers to a single middleware (`server/src/app.ts`), so every unhandled error is a consistent JSON 500 and a full log with the route — no try/catch in every handler
- **Contract validation** - the bodies of `POST /api/folder/queue` and `PUT /api/folder/config` are parsed with zod schemas (`server/src/routes/validation.ts`); a validation error is a 400 with the first problem described directly
- **Dependency injection** - `createApp` takes the token and the download queue (`createFolderRouter(queue)`), and the ES client has an injection point — tests do not reach for module singletons
- **Graceful shutdown** - `SIGINT`/`SIGTERM` cancels queue jobs (kills yt-dlp), shuts down the server, and forces exit after 10 s (`server/src/shutdown.ts`)

### Code quality

- **TypeScript** - strong typing across the project (details below)
- **Unit tests** - high test coverage (Jest + Vitest)
- **Linting** - Biome (strict rules) + ESLint (type-aware) to check code quality
- **Formatting** - Biome for consistent formatting
- **Validation** - checking API parameters and file paths

### Security

- **Path traversal protection** - file name sanitization
- **Path validation** - checking file existence before serving
- **Environment separation** - separate configuration for dev and prod
- **Environment variables** - sensitive data in `.env` (not committed)

### Typing

All three projects are compiled with TypeScript 6.0 (the same version Cursor uses to highlight errors). Beyond `strict`, the following are enabled:

| Flag                                                                    | Effect in practice                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `noUncheckedIndexedAccess`                                              | `array[0]` and `record[key]` have type `T \| undefined` - you must check before using                                                                                          |
| `exactOptionalPropertyTypes`                                            | a field `x?: string` can be omitted, but must not be assigned `undefined`; objects with optional fields are built by `stripUndefined()` from `server/src/utils/objectUtils.ts` |
| `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch` | Express handlers end with `res.json(...); return;`, not `return res.json(...)`                                                                                                 |
| `noUnusedLocals`, `noUnusedParameters`                                  | unused variables are a compile error (deliberately ignored parameters start with `_`)                                                                                          |
| `verbatimModuleSyntax` (client, extension)                              | types are imported via `import type`; on the server, ESLint enforces the same (`consistent-type-imports`)                                                                      |

**The shared API contract** lives in `shared/`: the zod schemas (`schemas.ts`) are the single source of truth for response shapes, and `api.ts` re-exports the types derived with `z.infer` (plus request types and SSE event types). The server, client, and extension import the types as `@shared/api`; the client **parses** every response against a schema (parse, don't trust), and the server route tests check responses against the same schemas — types and validation cannot drift apart. `api.ts` stays types-only (`import type` enforced by ESLint), while `schemas.ts` and `progress.ts` are deliberate runtime modules shared by the server and the extension.

Express routers use `RouteHandler<Params, Response>` from `server/src/routes/http.ts`: path params are derived from the route pattern, `req.body` is typed `unknown` and narrowed with the `readBody`/`readString` helpers, and `res.json()` only accepts the contract type (or `ApiError`). `any` is banned by lint (`no-explicit-any: error`) in code and tests.

## Project structure

```
video-search-app/
├── shared/
│   ├── api.ts           # Contract types (from schemas) + request/event types — types-only
│   ├── schemas.ts       # zod schemas for API responses (types via z.infer) — client and test validation
│   ├── progress.ts      # Shared yt-dlp progress parser (server + extension)
│   └── youtube.ts       # Shared YouTube id extraction from URLs (server + extension)
├── server/              # Backend (Node.js/Express)
│   ├── src/
│   │   ├── index.ts     # Server startup
│   │   ├── app.ts       # Express setup (middleware, routers)
│   │   ├── routes/      # HTTP layer — request parsing, statuses, no yt-dlp logic
│   │   │   ├── videos.ts    # Search, details, summaries, reindex
│   │   │   ├── folder.ts    # Folder configuration, list.json, download queue
│   │   │   └── http.ts      # RouteHandler, readBody/sendError (narrowing helpers in utils/objectUtils)
│   │   ├── services/    # Business logic (does not depend on routes/)
│   │   │   ├── videoScanner.ts
│   │   │   ├── elasticsearchService.ts
│   │   │   ├── downloadQueue.ts  # Job queue — uses buildYtDlpArgs from ytdlp.ts
│   │   │   ├── ytdlp.ts         # ALL interaction with yt-dlp: argument templates + spawn
│   │   │   ├── channelList.ts   # Reads a channel's list.json
│   │   │   ├── folderConfig.ts
│   │   │   └── folderIndex.ts
│   │   ├── utils/       # Helpers
│   │   │   ├── commentTreeUtils.ts
│   │   │   ├── logger.ts        # The only module touching console (level + timestamp)
│   │   │   ├── objectUtils.ts   # stripUndefined(), narrowing helpers (isRecord/readString/errnoCode)
│   │   │   └── videoPathUtils.ts
│   │   ├── config.ts    # Configuration (env, video folder glob)
│   │   ├── types.ts     # Server-internal types (e.g. VideoInfoJson from yt-dlp)
│   │   └── test-utils.ts    # at()/entry() - test helpers without undefined
│   ├── tsconfig.json        # Code + tests (typecheck, IDE)
│   ├── tsconfig.build.json  # Production code only (npm run build)
│   └── package.json
├── client/              # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/  # React components
│   │   │   ├── SearchBar.tsx, VideoCard.tsx, VideoList.tsx
│   │   │   ├── VideoItem.tsx, VideoListSection.tsx
│   │   │   ├── CommentComponent.tsx, VideoComments.tsx, VideoSummary.tsx
│   │   │   └── FolderSection.tsx, FolderConfigEditor.tsx, PlaylistDownloadSection.tsx
│   │   ├── pages/       # App pages
│   │   │   ├── StatusPage.tsx        # / - folders, configuration, and queue
│   │   │   ├── VideoListPage.tsx     # /videos - search
│   │   │   └── VideoDetailPage.tsx   # /video/:id - details + player
│   │   ├── hooks/       # Custom hooks
│   │   │   ├── useVideoSearch.ts, useVideoDetail.ts, useVideoSummary.ts
│   │   │   ├── useDownloadQueue.ts, useCacheRefresh.ts, useRecreateIndices.ts
│   │   │   ├── useCategories.ts, useSearchUrlState.ts
│   │   ├── reducers/    # State management
│   │   │   ├── videoSearchReducer.ts, videoDetailReducer.ts, videoSummaryReducer.ts
│   │   │   ├── cacheRefreshReducer.ts, statusReducer.ts, recreateIndicesReducer.ts
│   │   ├── utils/       # searchUrlState.ts, folderConfigForm.ts, videoDates.ts
│   │   ├── test/        # Vitest setup and typed fetch mock (fetchMock.ts)
│   │   └── App.tsx      # Root component
│   └── package.json
├── chrome-extension/     # Chrome extension (TypeScript + Vitest)
│   ├── src/              # Source code (background, content, popup, options)
│   │   └── lib/          # Pure logic with tests (SSE, progress, YouTube id)
│   ├── package.json      # npm run build (esbuild) / test (vitest) / typecheck
│   ├── manifest.json     # MV3; points at the generated *.js in the root directory
│   └── *.js              # Build output (not committed)
└── .env                 # Environment variables (do not commit!)
```

### Chrome extension

The extension is written in TypeScript (strict, the same strict flags as the
rest of the repo) and built with esbuild into classic scripts in the root
directory (`chrome-extension/*.js` — not committed, gitignore). Pure logic —
SSE framing (`feedSseBuffer`/`parseSseEvent`), extracting yt-dlp progress,
recognizing YouTube ids — lives in `chrome-extension/src/lib/` and has
Vitest tests. The SSE event contract is shared with the server via
`shared/api.ts` (imported with `import type`). Commands:

```bash
npm run build:extension   # esbuild → background/content/popup/options.js
cd chrome-extension && npm test   # unit tests
cd chrome-extension && npm run typecheck
```

## Features

- **Video search** - full-text search over file name, title, description, subtitle transcript, and comments using Elasticsearch; Polish characters work without diacritics (`srodek` = `środek`), sorting by relevance or by field, paginated results ("Show more")
- **Multiple folder support** - scan videos from many directories at once
- **Cache refresh** - a "Refresh Cache" button for manually reindexing videos from disk, with progress in a toast; search keeps working on the previous index version in the meantime
- **List reload** - a "Reload" button to reload the currently displayed videos
- **Video list** - videos with thumbnails (`.webp`)
- **Video player** - playing videos in the browser (HTML5 video) with subtitles (`<track>` from the downloaded `.vtt` files)
- **Video details** - detailed information about a video:
  - Title and description
  - View and like counts
  - Publication date and duration
  - Channel name
- **Comments** - comments with nested replies
  - Expanding/collapsing long comments
  - Comment like counter
  - Comment dates with friendly formatting
- **Sorting** - sorting search results:
  - By date (newest/oldest)
  - By view count (descending/ascending)
  - By like count (descending/ascending)
- **Category filtering** - every channel has a category in its `config.json` (e.g. `fpv`, `lego`, `psychology`); choosing a category narrows the search to its channels
- **Search in the URL** - the phrase, sorting, and category live in the list page address, e.g. `/videos?q=motor&sort=views-desc&category=fpv`. Such a link can be saved or sent: on opening, the form and results reflect the parameters. Default values (no phrase, `date-desc`, all categories) do not go into the address, and an unknown `sort` falls back to the default. The page replaces its history entry instead of adding a new one, so "back" leaves the list instead of undoing filters.
- **Responsive design** - adaptation to different screen sizes
- **Chrome extension** - adding videos to the download queue straight from YouTube: video detection on the page, live progress (SSE), active-download counter on the extension icon (details in [chrome-extension/README.md](chrome-extension/README.md))

## Frontend architecture

A short overview of the client's architectural decisions and what was consciously **not** implemented:

- **StrictMode** — enabled; dev double-renders to catch impure renders.
- **Reducers on `as const`** — action types are `as const` + a union type
  instead of enums (less runtime code, full literal inference in `switch`).
- **`useDebouncedValue`** — a single debounce hook (search phrase and channel filter).
- **Virtualization** — the channel's video list (Status) uses react-window
  (`VariableSizeList`, thousands of rows); the search result grid is a
  responsive grid of variable-height cards, so instead of react-window
  it uses `content-visibility: auto` (the browser skips rendering cards
  off-screen).
- **TanStack Query** — a recommendation, not an implementation. Around 400
  lines of hand-written fetch hooks (useVideoSearch, useVideoDetail, useStatus,
  useDownloadQueue) cover the caching, retries, and synchronization that
  TanStack Query provides out of the box; the migration is worth doing at the
  next larger data refactor, not during small changes.
- **React Compiler** — a recommendation, not an implementation.
  Auto-memoization would remove the manual `memo`/`useCallback`
  (VideoItem, VideoCard, CommentComponent), but it needs verification
  against react-window and react-i18next; enable it as a separate,
  conscious step.

## Developer tooling

- **Shared TypeScript** — `tsconfig.base.json` at the root holds the common
  strictness rules (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess, …);
  client/server/extension inherit them and add only their own options. The
  server has `isolatedModules` (per-file typecheck), and the extension
  typechecks the whole `../shared` directory, not selected files.
- **Husky + commitlint + lint-staged** — `pre-commit` formats and lints
  changed files (biome check --write), `commit-msg` enforces
  the conventional commits convention (`feat:`, `fix:`, `chore(tooling):`, …) —
  the end of mixed styles in the history.

## API Endpoints

### GET /health (public)

Readiness probe: pings Elasticsearch and returns `200 { status: 'ok', elasticsearch: 'ok' }`, and when ES does not respond — `503 { status: 'degraded', elasticsearch: 'down' }`. The Chrome extension uses it in „Test połączenia" ("Test connection"). The ping result is cached for 5 s, so frequent polling does not burden ES.

### GET /health/live (public)

Dependency-free liveness probe: `200 { status: 'ok' }` when the server process responds.

### GET /metrics (public)

Prometheus: `http_requests_total` and `http_request_duration_seconds` (method/route/status labels; unknown paths go to the `unmatched` label so as not to multiply series per URL), `download_queue_size`, and summary cost metrics: `openai_summary_requests_total`, `openai_summary_tokens_total`, `openai_summary_estimated_cost_cents_total` (a USD estimate based on approximate model pricing).

### GET /api/videos/refreshCache

Refreshes and reindexes all videos from the configured folders into Elasticsearch.

**Response:**

```json
{
  "message": "Cache refresh process started",
  "status": "ok"
}
```

**Cache on removable drives.** Each folder's index lives in Elasticsearch under an alias computed from the folder path and **survives unplugging the drive** — after swapping drives, search immediately uses the aliases of the currently attached folders (the previous drive is simply not searched), and the status page shows only the missing index per folder (`indeks ES: brak` — "ES index: missing"). Instead of a full reindex, it is then enough to call:

```
GET /api/videos/refreshCache?onlyMissing=1
```

— only folders without an existing index are reindexed (e.g. a drive attached for the first time); folders with a cache are skipped and keep serving search. In the web UI this is the **„tylko brakujące (użyj istniejącego indeksu)" ("only missing (use existing index)")** checkbox next to the „Odśwież indeks" ("Refresh index") button. A full reindex (without the parameter) remains for situations where the drive contents changed and the existing index must be rebuilt.

**Note:** This endpoint starts the indexing process in the background and returns immediately. If a reindex is already running, it returns `409` with the current status. Progress can be followed via `GET /api/videos/refreshCache/status` (the client does this itself and shows it in a toast).

### GET /api/videos/refreshCache/status

State of the ongoing (or last) reindex.

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

`filesDone/filesTotal` refer to the current folder, `indexed/skipped` to the whole run. `errors` is the list of folders that failed to index (max. 20 entries), `lastError` — the last error message, and `finishedAt` appears once finished.

#### How the reindex works

Every folder has an **alias** `videos_<sha256(folderPath)[:16]>` in Elasticsearch, pointing at exactly one physical index `videos_<hash>_<timestamp>`. The reindex:

1. creates a new, empty physical index,
2. reads `info.json` from disk and writes documents in batches (`_bulk`) — at most 50 documents or ~16 MB per request, because channels with tens of thousands of comments have `info.json` files of 50 MB and Elasticsearch rejects requests above 100 MB,
3. once the whole folder is written, atomically switches the alias to the new index (`_aliases`) and deletes the previous one.

Thanks to this, search works the whole time on the old index version, and an interrupted reindex (error, server restart) does not leave an empty index — at most an orphaned `videos_<hash>_<timestamp>` index, which is removed at the next successful reindex of that folder. Videos with the same `videoId` (duplicates on disk) go into a single document.

Comments are **not** stored in ES as objects — only as one text field `commentsText`, which search runs over. The `GET /api/videos/:id/details` endpoint reads the full comment tree from `info.json`. The `commentsText` field is not returned in search results.

After every download-queue job (`download`/`update`), the changed videos are indexed incrementally, so a new video is visible in search without a full reindex.

**Changing the analyzer requires a reindex:** existing indexes keep the
mappings from their creation time, so after an upgrade that changes text
analysis (e.g. introducing `polish_folded`), call `GET /api/videos/refreshCache` — new
indexes get the new analyzer, and the aliases switch atomically.

### GET /api/videos/search

Searches videos by phrase in the file name (`baseName.text^4`), title (`^3`), description (`^2`), subtitle transcript (`transcriptText^2`), and comments (`commentsText`). Text is analyzed with **diacritic folding** (custom `polish_folded` analyzer: `standard` + `lowercase` + `asciifolding`), so `srodek` finds `środek` without typing Polish characters. Polish stemming/stop words would require the `analysis-stempel` plugin (absent from the default Docker image), so the analyzer uses only built-in components. Transcripts and comments are search-only fields — they are never returned in responses.

**Query parameters:**

- `q` (optional) - search phrase
- `sort` (optional) - sort order:
  - `relevance` - by relevance (default Elasticsearch behavior, `_score`; only meaningful with a phrase)
  - `date-desc` - by date, newest first (default)
  - `date-asc` - by date, oldest first
  - `views-desc` - by view count, descending
  - `views-asc` - by view count, ascending
  - `likes-desc` - by like count, descending
  - `likes-asc` - by like count, ascending
- `category` (optional) - narrows the search to channels with this category (case-insensitive comparison). `totalCount` then applies to the category alone. A category that exists in no `config.json` returns zero results - never everything.
- `offset` (optional, default 0) - first result to return (pagination)
- `limit` (optional, default 100, max. 500) - results per page

The client appends further pages with the "Show more" button while `videos.length < totalCount`.

**Response:**

```json
{
  "videos": [
    {
      "baseName": "video_name",
      "title": "Video title",
      "description": "Description...",
      "videoPath": "video_name.mp4",
      "thumbnailPath": "video_name.webp",
      "folderPath": "/path/to/folder",
      "uploadDate": "20231201",
      "viewCount": 1000,
      "likeCount": 50,
      "channelName": "Channel name",
      "comments": []
    }
  ]
}
```

### GET /api/videos/categories

Categories declared in the `config.json` files of the configured folders - sorted, without duplicates (variants differing only in case are merged). Feeds the picker in search.

```json
{ "categories": ["fpv", "lego", "psychology"] }
```

The category **does not go into Elasticsearch**. Every folder has its own index alias, so the filter simply narrows the list of searched aliases to the folders with the given category. This makes `config.json` the single source of truth: changing a category works immediately and **does not require a reindex**.

The `config.json` files are read in parallel, and the folder → category map is kept in memory for 5 s (`CATEGORY_CACHE_TTL_MS`), because on an external drive a sequential read of 56 files on every search cost 0.7–3 s. A write through `PUT /api/folder/config` clears the cache immediately; a file changed by hand on disk becomes visible after at most 5 s.

### GET /api/videos/file/:filename?folder=<path>

Serves video files (.mp4) and thumbnails (.webp).

**Parameters:**

- `filename` - the file name (e.g. `video.mp4`, `thumbnail.webp`)
- `folder` (optional, recommended) - the folder the file lives in; must be one of those configured in `VIDEOS_FOLDER_PATH` (otherwise 403). Without this parameter, the file is looked up by name in Elasticsearch.

### GET /api/videos/:baseName/details

Returns detailed information about a video together with its comments.

**Parameters:**

- `baseName` - the base file name without extension

**Response:**

```json
{
  "details": {
    "title": "Video title",
    "description": "Full description...",
    "uploadDate": "20231201",
    "duration": "10:30",
    "viewCount": 1000,
    "likeCount": 50,
    "channelName": "Channel name",
    "comments": [
      {
        "id": "comment_id",
        "author": "Comment author",
        "text": "Comment text",
        "like_count": 10,
        "timestamp": 1701446400,
        "replies": []
      }
    ],
    "commentCount": 25,
    "videoPath": "video_name.mp4",
    "thumbnailPath": "video_name.webp",
    "folderPath": "/path/to/folder"
  }
}
```

### Downloading from YouTube (`/api/folder/*`)

Endpoints for managing a channel folder (all require a `folderPath` from the `VIDEOS_FOLDER_PATH` list):

| Endpoint                                                | Description                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/status`                                       | List of folders and their `config.json`                                                                                                                |
| `PUT /api/folder/config`                                | Writes `config.json` (`{ folderPath, config: { channelUrl, category, ... } }`)                                                                         |
| `POST /api/folder/download-playlist`                    | `yt-dlp --flat-playlist -j` → `list.json`                                                                                                              |
| `GET /api/folder/list-exists?folderPath=`               | Whether `list.json` exists                                                                                                                             |
| `GET /api/folder/list?folderPath=`                      | Contents of `list.json` + download statuses (from the folder index)                                                                                    |
| `GET /api/folder/video-downloaded?folderPath=&videoId=` | Whether the video is downloaded                                                                                                                        |
| `POST /api/folder/rebuild-index`                        | Rebuilds the folder index and `archive.txt` from disk                                                                                                  |
| `POST /api/folder/queue`                                | Adds jobs to the queue: `{ folderPath, type: "download" \| "update", videos: [{ videoId, videoUrl?, title? }] }` → `202 { jobs, skipped }`             |
| `GET /api/folder/queue?folderPath=`                     | Queue state (`queued/running/done/error/cancelled`, progress, log tail)                                                                                |
| `DELETE /api/folder/queue/:jobId`                       | Cancels a job (kills the process if running)                                                                                                           |
| `DELETE /api/folder/queue?folderPath=`                  | Cancels all jobs of a folder                                                                                                                           |
| `POST /api/folder/download-video`                       | Single download with an SSE stream (used by the Chrome extension); the job goes to the queue anyway, closing the connection does not stop the download |

**The download queue** runs server-side (`server/src/services/downloadQueue.ts`): jobs are not tied to the HTTP request, so closing the tab does not stop `yt-dlp`. Downloads and updates have separate limits. At most `DOWNLOAD_CONCURRENCY` downloads run in parallel (default 2) and only one per folder, because each appends to that folder's `archive.txt`. Metadata updates — at most `UPDATE_CONCURRENCY` (default 2), and also one at a time per folder: each writes only under its own file stem, and the folder index refresh after a job is queued per folder, so parallel jobs do not overwrite each other's `.videos-index.json`. When raising this limit, remember that every `yt-dlp` process (especially with `--write-comments`) means many requests to YouTube from a single IP address; 429 errors or a sign-in prompt are a signal to go back to a smaller value. The client polls `GET /api/folder/queue` every 1.5 s, only when there is something in the queue. The queue is kept in memory — a server restart clears it.

**Two kinds of jobs:**

- `download` - a full download with `--download-archive archive.txt`; a video whose id is already in `archive.txt` is not downloaded a second time, even if its title changed on YouTube.
- `update` - metadata only (`--skip-download`), saved under the **existing** base file name (`-o "<baseName>.%(ext)s"`), so `info.json`, the description, the thumbnail, and subtitles are overwritten in place, not created under a new title.

**Folder index** (`server/src/services/folderIndex.ts`): every folder holds a hidden `.videos-index.json` file (`videoId → { baseName, videoFile, infoMtime }`) plus yt-dlp's `archive.txt`. Both are built from disk on first use (only the header of each `info.json` is read) and updated incrementally after every job, so `GET /api/folder/list` no longer parses all `info.json` files. After manually deleting files from the folder, call `POST /api/folder/rebuild-index`.

## yt-dlp file format

The app expects the following file structure in the folder:

```
folder/
├── video_name.description      # Video description (required for search)
├── video_name.mp4              # Video file
├── video_name.webp             # Thumbnail
├── video_name.info.json        # Metadata (title, stats, comments)
├── config.json                 # Channel configuration and download options (see below)
├── list.json                   # Channel video list (yt-dlp --flat-playlist)
├── archive.txt                 # yt-dlp archive (youtube <id>) - protects against duplicates
└── .videos-index.json          # Index of downloaded videos (generated automatically)
```

The app automatically scans all configured folders and indexes files meeting the criteria above.

### config.json - per-folder channel configuration and download options

```json
{
  "channelUrl": "https://www.youtube.com/@channel",
  "category": "fpv",
  "maxHeight": 1080,
  "subLangs": ["pl", "en"],
  "writeComments": false,
  "extraArgs": ["--no-playlist"]
}
```

| Key                   | Default  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `channelUrl`          | -        | Channel address; `list.json` is generated from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `category`            | -        | Channel category (max. 64 characters, single line); allows narrowing the search to one topic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `maxHeight`           | `2160`   | Maximum video height (144-4320). Prefers h264/aac in mp4, then any codec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subLangs`            | `["en"]` | Subtitle languages for `--sub-lang` (`pl`, `en`, `en.*`, `all`). An empty array disables subtitles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `writeComments`       | `true`   | Whether to download comments (`--write-comments`) - they are indexed for search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `extraArgs`           | `[]`     | Extra yt-dlp flags appended after the built-in ones, e.g. `["--no-playlist"]` (separate entries as in argv, no quotes). Reserved are the flags the pipeline relies on: `-f/--format`, `-o/--output`, `-P/--paths`, `--download-archive`, `--no-download-archive`, `--merge-output-format`, and forbidden (security): `--exec`, `--config-locations`, `--cookies`/`--load-cookies`/`--cookies-from-browser`, `--proxy`, `--netrc`, `--username`, `--password`, `--video-password` — `PUT /api/folder/config` rejects them, and in a hand-edited file they are ignored (together with their value) |
| `impersonate`         | `false`  | Adds `--impersonate chrome` — impersonating a browser without cookies (a safe alternative to the forbidden `--cookies*`); helps when YouTube responds with 429 or treats the server as a bot                                                                                                                                                                                                                                                                                                                                                                                                     |
| `concurrentFragments` | `1`      | Number of parallel download fragments (`-N`, 1-16); higher values speed up downloads because YouTube throttles a single connection                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sponsorblockRemove`  | `false`  | Adds `--sponsorblock-remove sponsor,selfpromo,interaction` — cuts sponsor segments at download time (ffmpeg, cuts at keyframes without re-encoding)                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Missing keys fall back to their defaults (`GET /api/status` returns them in `downloadDefaults`). Invalid values in a hand-edited file are ignored, and `PUT /api/folder/config` rejects them. Options are read at the moment a job is added to the queue. The UI editor (status page) lets you set them without editing the file by hand.

### Adding subtitles in another language (without re-downloading)

To pull in, say, Polish subtitles next to the English ones for an already downloaded channel:

1. In the channel's `config.json` set `subLangs: ["en", "pl"]` and add to `extraArgs`:
   `["--no-write-comments", "--no-write-info-json", "--no-write-thumbnail", "--no-write-description"]`
   — updates will then download **only subtitles**: no comments (the slowest part)
   and no overwriting of `info.json` (existing comments and metadata stay untouched).
2. In the channel's section on the status page, click **„Aktualizuj wszystkie" ("Update all")** (or „Aktualizuj stare" ("Update old")
   for videos older than a month) — the queue will download the new `.pl.vtt` files under the existing
   file names.
3. The new subtitles are visible in the player immediately (the details endpoint reads the `.vtt` files from disk)
   — no reindex needed. You can raise the pace with the `UPDATE_CONCURRENCY` variable (default: 2 parallel).
   Once done, clear `extraArgs` if you want to go back to full updates.
