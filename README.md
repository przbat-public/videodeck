# Video Search App

[![CI](https://github.com/przbat-public/videodeck/actions/workflows/ci.yml/badge.svg)](https://github.com/przbat-public/videodeck/actions/workflows/ci.yml)
[![CodeQL](https://github.com/przbat-public/videodeck/actions/workflows/codeql.yml/badge.svg)](https://github.com/przbat-public/videodeck/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/przbat-public/videodeck)](https://github.com/przbat-public/videodeck/releases)

A self-hosted web app for searching and watching YouTube videos downloaded
with yt-dlp. Titles, descriptions, comments and subtitle transcripts land in
an Elasticsearch index; the browser player handles multi-language subtitles;
a server-side queue drives yt-dlp per channel. A Chrome extension enqueues
videos straight from YouTube.

- Search works when you skip Polish diacritics: `srodek` finds `środek`
- In-browser player with the downloaded subtitles
- Per-channel download settings and a queue that survives closed tabs
- Polish/English UI with a dark theme

## Screenshots

<p align="center">
  <img src="docs/screenshots/search.png" alt="Search with filters" width="48%">
  <img src="docs/screenshots/status.png" alt="Channel download console" width="48%">
  <img src="docs/screenshots/detail.png" alt="Video player with subtitles" width="48%">
</p>

> Polish documentation: [Polish version](docs/README.pl.md)

## Features

- **Video search** - full-text search over title, description, transcript and
  comments with diacritic folding; sort by relevance, date, views or likes,
  paginated results
- **Video player** - HTML5 playback with subtitles from the downloaded `.vtt`
  files
- **Details** - title, description, stats, channel and the comment tree with
  nested replies
- **Filters** - category (per channel, from `config.json`) and channel; the
  whole search state lives in the URL, so links are shareable
- **Cache refresh** - reindex from disk without downtime (alias switching),
  with an "only missing" mode for freshly attached drives
- **Download queue** - download and update jobs, per-folder concurrency,
  pause, cancel, live progress
- **Chrome extension** - enqueue from YouTube with SSE progress and a badge
  counter
- **Responsive + dark mode** - works from phone to desktop, light/dark/system
  theme
- **Polish and English UI**

## Quickstart

1. Install dependencies for the whole workspace:

   ```bash
   pnpm install   # frozen, CI-style: pnpm run install:ci
   ```

2. Start Elasticsearch (bound to loopback; no password):

   ```bash
   docker run -d --name videodeck-elasticsearch --restart unless-stopped \
     --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
     -p 127.0.0.1:9200:9200 \
     -v videodeck-es-data:/usr/share/elasticsearch/data \
     -e discovery.type=single-node \
     -e xpack.security.enabled=false \
     -e xpack.security.enrollment.enabled=false \
     -e ES_JAVA_OPTS="-Xms1g -Xmx1g" \
     --health-cmd 'curl -fs "http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=5s" >/dev/null || exit 1' \
     --health-interval 10s --health-timeout 10s --health-retries 30 --health-start-period 60s \
     docker.elastic.co/elasticsearch/elasticsearch:9.5.1
   ```

   Run it as written. The name, the volume and the restart policy are what make
   the node survive a Docker restart without a reindex, and the health flags
   make `docker ps` show `(healthy)` once the cluster accepts work. The first
   boot takes about half a minute. Each flag is explained in the
   [installation reference](docs/INSTALL.md), along with the Homebrew and
   manual routes.

3. Create `server/.env`:

   ```
   VIDEOS_FOLDER_PATH=/path/to/videos/folder
   ELASTICSEARCH_URL=http://localhost:9200
   ```

   Several folders? Separate them with `;` or `,`. Removable-drive patterns
   and every optional variable are covered in the same reference.

4. Run the app:

   ```bash
   pnpm run dev
   ```

   Server on `http://localhost:3001`, UI on `http://localhost:3000`.

5. Index the videos once. On the film list, open the gear menu in the top
   bar and pick **"Refresh index"** (pl: „Odśwież indeks"), or call
   `POST /api/videos/refreshCache`. Large libraries take a while; progress
   shows in a toast.

## Requirements

- Node.js 24, 24.22.3 or later (corepack provides pnpm 12.4.2, pinned in `packageManager`)
- Elasticsearch 8.x or 9.x (local or remote)
- Chrome 102+ (only for the Chrome extension)

## Configuration

The essentials:

| Variable              | What it does                                                                    |
| --------------------- | ------------------------------------------------------------------------------- |
| `VIDEOS_FOLDER_PATH`  | one or more folders to scan (separate with `;` or `,`)                          |
| `ELASTICSEARCH_URL`   | Elasticsearch address                                                            |
| `API_TOKEN`           | bearer token protecting `/api`; set it before exposing the server beyond loopback |
| `OPENAI_API_KEY`      | enables AI summaries (`GET /api/videos/:id/summary`)                            |
| `DEEPSEEK_API_KEY`    | runs those summaries on DeepSeek instead; `SUMMARY_PROVIDER` pins either provider |

Either key turns summaries on, and adding the DeepSeek one is the switch: with
both present DeepSeek answers, unless `SUMMARY_PROVIDER=openai` says otherwise.

The full reference (concurrency, rate limits, CORS, host allowlist,
extension origins and more) is in the installation reference linked above.
Security implications are in the Security section below.

## Documentation

| Document                                        | Covers                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| [INSTALL.md](docs/INSTALL.md)                   | setup options, every environment variable, production builds           |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)             | Docker deployment, upgrades, backups                                   |
| [API.md](docs/API.md)                           | HTTP endpoints, the indexing model, on-disk formats, `config.json`     |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)           | linting, tests, coverage, typing, project layout                        |
| [architecture](docs/architecture/)              | typed runtime architecture diagrams                                    |
| [DESIGN.md](DESIGN.md)                          | the UI design contract; a static landing page built from the same tokens lives at [docs/landing/index.html](docs/landing/index.html) |
| [README.pl.md](docs/README.pl.md)               | this file in Polish                                                    |
| [CONTRIBUTING.md](CONTRIBUTING.md)              | workflow, quality gates, conventions                                   |
| [SECURITY.md](SECURITY.md)                      | vulnerability reporting and scope                                      |
| [CHANGELOG.md](CHANGELOG.md), [RELEASING.md](RELEASING.md) | what changed, how releases are cut                        |
| [extension README](chrome-extension/README.md)  | the extension                                                          |

## Development

```bash
pnpm run dev          # server :3001 + client :3000
pnpm run test         # unit tests: server, client and extension (vitest)
pnpm run test:e2e     # Playwright against the mocked API (first run and after every Playwright bump: cd client && pnpm exec playwright install chromium)
```

Lint rules, the test matrix, the coverage ratchet and the strict TypeScript
flags: [DEVELOPMENT.md](docs/DEVELOPMENT.md). The branch/PR/squash workflow
and the full verification gate are described in CONTRIBUTING.md.

## Architecture

The runtime architecture is authored as typed JSON in
[docs/architecture/](docs/architecture/) and compiled by the vendored
archify CLI (MIT) into a self-contained interactive map
(`videodeck.architecture.html` in the same directory).
`pnpm run test:scripts` validates every diagram and checks that the
committed HTML matches a fresh render, so the map cannot drift from its
source.

## Internationalization (Polish / English)

- **Client** (`client/src/i18n/`): react-i18next with `locales/pl.json`
  and `en.json` catalogs. All UI strings (pages, components, toasts, reindex
  progress, job statuses) go through `t()` with typed keys (a typo in a key
  is a TypeScript error). Polish is the default and fallback language;
  the PL/EN switcher in the top-right corner saves the choice to localStorage.
  Pluralization uses i18next rules (the Polish catalog has 1 film / 2 filmy / 5 filmów forms).
- **Chrome extension** (`chrome-extension/_locales/{pl,en}/messages.json`):
  native `chrome.i18n`: `default_locale: "pl"` in the manifest,
  `chrome.i18n.getMessage` in the code, and the static HTML is translated via
  `[data-i18n]` (`src/lib/i18n.ts`). The extension follows the browser
  language (fallback: Polish).
- **Server**: API messages stay in English (stable for logs and
  tests); the client adds its own translated error prefixes.

A new key is added in `pl.json`, `en.json` (optionally in the extension's
`messages.json`); client keys are type-checked, so an inconsistency surfaces
in typecheck. Client tests run with the default Polish; E2E checks
language switching in both directions.

## Security

The server listens on `127.0.0.1` only by default, and CORS allows only
the local dev client (`localhost`/`127.0.0.1` on ports 3000, 4173 and 5173),
Chrome extensions and the origins listed in `CORS_ORIGINS`. Without
`API_TOKEN`, the API is open to local processes.

A browser request marked `Sec-Fetch-Site: cross-site` is answered 403,
token or not. Browsers send that marker only to HTTPS and loopback
addresses, so on a LAN address such as `http://nas.local:3000` the server
reads the `Origin` instead. There a browser's write passes only from the
UI's own address, a host in `ALLOWED_HOSTS` (on any port) or a trusted
origin: the dev client ports above (any local app on the viewer's machine
can serve one), a Chrome extension (just the ids in `EXTENSION_ORIGINS`
once that is set) and `CORS_ORIGINS`. A page on any other site cannot
trigger a reindex or enqueue jobs, so list only what you run. A link or an
image sends no `Origin`, and its GET goes on to the token check like
curl's. The page cannot read the answer, but in this version a summary
GET still generates a summary that is not cached yet, and the provider
bills it.

Additional protections:

- **Host allowlist (DNS rebinding)**: the server only accepts a `Host`
  header from loopback (`localhost`, `127.0.0.1`, `[::1]`) or from
  `ALLOWED_HOSTS`. An attacker's domain that resolves to 127.0.0.1 sends
  its own `Host` and gets a 403 before it reaches the API.
- **SSRF via video URL**: `POST /api/folder/queue` and `/api/folder/download-video`
  accept only YouTube URLs (recognized by `shared/youtube.ts`);
  any other URL (including `file://` or IP addresses) is rejected, and yt-dlp
  always receives the canonical `https://www.youtube.com/watch?v=<id>`. A
  channel URL in `config.json` passes the same host check when it is saved
  and again before the playlist fetch, and yt-dlp lists the URL rebuilt
  from its host and path.
- **yt-dlp argument allowlist**: `extraArgs` in `config.json` accepts only
  the exact flag names in `ALLOWED_EXTRA_ARGS`
  (`server/src/services/folderConfig.ts`), each with its value checked.
  Nothing else gets through, so `--exec`, the cookie and credential flags,
  `--alias`, clustered short options and abbreviated long forms never reach
  yt-dlp (RCE, cookie theft, credential leaks). `PUT /api/folder/config`
  answers 400 and lists the allowed flags, a hand-edited file loses the
  entry together with its value, and the argument builder checks again
  before yt-dlp starts. Every download, update, repair and channel listing
  passes `--ignore-config`, so a `yt-dlp.conf` in a channel folder adds
  nothing.
- **No open API on a network interface**: the server refuses to start when
  `HOST` is not a loopback address and neither `API_TOKEN` nor
  `REQUIRE_API_TOKEN=true` is set. Publishing the API to the network takes a
  token, not a forgotten variable.
- **Exact extension id in CORS**: by default (dev mode), CORS allows
  any `chrome-extension://…` because developer extensions get a new id
  each time they are loaded. Set `EXTENSION_ORIGINS` with the exact id
  (visible on `chrome://extensions`) so that the API is only called by
  your extension. Keep it current: over plain HTTP the server refuses an
  extension whose id the list does not name.

For remote access, set `API_TOKEN` (and optionally `HOST=0.0.0.0` +
`ALLOWED_HOSTS`): every request to `/api` must then carry
`Authorization: Bearer <token>`. `CORS_ORIGINS` is for a page on another
port or subdomain of the API's own site that calls it directly; a request
the browser marks cross-site stays refused even from a listed origin.
Over plain HTTP the host the browser uses must be loopback or in
`ALLOWED_HOSTS`, whatever proxy sits in front: an `X-Forwarded-Host`
counts only for such a name. The Chrome extension has a "Token API" (pl: „Token API")
("API token") field in its options; `/health` stays public for connection
tests.

Vulnerability reporting and scope: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Bugs, ideas and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); the architecture map lives in
[docs/architecture/](docs/architecture/).
