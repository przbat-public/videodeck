# Contributing

Thanks for considering contributing to video-search-app! This is a self-hosted
tool for searching, browsing and managing YouTube videos downloaded with
[yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Getting started

Prerequisites:

- Node.js 22 (`.nvmrc` pins it; `nvm use` picks it up)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) in `PATH` (downloads; the
  **nightly** channel is recommended — YouTube breaks old releases regularly)
- Elasticsearch (Docker: `docker run -p 127.0.0.1:9200:9200 -e "discovery.type=single-node" -e "xpack.security.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:9.2.0`)
- ffmpeg in `PATH` (format merging, SponsorBlock cutting)
- Chrome only if you work on the browser extension

Install dependencies (four separate npm packages, no workspaces):

```bash
npm run install:all   # or: npm install && npm install --prefix server && npm install --prefix client && npm install --prefix chrome-extension
```

Configure `server/.env` (copy from `server/.env.example`).

Run the stack:

```bash
npm run dev          # server on :3001 + Vite client on :3000 (proxies /api)
```

## Quality gates

Every change must pass, from the repo root:

```bash
npm run format:check   # prettier
npm run lint           # eslint --max-warnings 0
npm run typecheck      # server + client + extension
npm test               # jest (server) + vitest (client, extension)
cd client && npm run test:e2e   # Playwright (mocked API, needs no backend)
```

Commit hooks (husky + lint-staged) format and lint the staged files
automatically.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore(tooling):`…) — enforced by commitlint. Keep subjects
  in English or Polish, be consistent within a change.
- **UI text** lives in i18n catalogs (`client/src/i18n/locales/`), Polish by
  default, with an English catalog; `client/src/i18n/locales.test.ts` enforces
  key parity between languages.
- **API contract** lives in `shared/schemas.ts` (zod): types are derived from
  schemas, so runtime validation and static types cannot drift.
- **Server-side data from the network**: parse, don't trust — narrow request
  inputs (see `server/src/routes/http.ts`, `validation.ts`).
- **Tests**: every behavior change ships with tests. The server integration
  suites (real Elasticsearch/yt-dlp) are env-gated
  (`RUN_ES_INTEGRATION`, `RUN_YTDLP_INTEGRATION`) and skipped by default.

## Pull requests

1. Open an issue first (or comment on an existing one) for anything larger
   than a trivial fix — discuss before building.
2. Branch off `main`, keep commits focused.
3. Run the full gate list above locally.
4. PRs are linted/typechecked/tested in CI; the e2e suite runs on every PR.
   Reviewers are humans — small, well-described PRs land fastest.

## Project layout

```
server/            Express 5 + ES + download queue (yt-dlp) + OpenAI summaries
client/            React 19 + Vite UI (i18n pl/en, Playwright e2e)
chrome-extension/  MV3 extension: enqueue videos from YouTube (SSE progress)
shared/            zod API contract + helpers shared by server and extension
```

See the README for the architecture and API documentation.
