# Contributing

Thanks for considering contributing to video-search-app! This is a self-hosted
tool for searching, browsing and managing YouTube videos downloaded with
[yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Getting started

Prerequisites:

- Node.js 22 (`.nvmrc` pins it) + corepack/pnpm 12.4.2 (`packageManager`)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) in `PATH` (downloads; the
  **nightly** channel is recommended: YouTube breaks old releases regularly)
- Elasticsearch (Docker: `docker run -p 127.0.0.1:9200:9200 -e "discovery.type=single-node" -e "xpack.security.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:9.5.1`)
- ffmpeg in `PATH` (format merging, SponsorBlock cutting)
- Chrome only if you work on the browser extension

Install the pnpm workspace:

```bash
pnpm install          # frozen CI-style reset: pnpm run install:ci
```

Configure `server/.env` (copy from `server/.env.example`).

Run the stack:

```bash
pnpm run dev         # server on :3001 + Vite client on :3000 (proxies /api)
```

## Quality gates

Every change must pass, from the repo root:

```bash
pnpm run verify
```

`verify` chains format, lint, lint:types, lint:scripts, test:scripts,
knip, lint:deps, humanizer:gate, typecheck, test, test:integration and
the client e2e suite, in that order. Each step also has its own script
(listed in `AGENTS.md`) for the inner loop.

CI also runs a `pnpm audit` job (moderate and above) and the weekly
dependency report; releases follow `RELEASING.md`.

Commit hooks (husky + lint-staged) run `biome check --write` on the staged
files automatically.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore(tooling):`…), enforced by commitlint.
  **All commit messages, PR titles/descriptions and code comments are written
  in English.** Polish is reserved for user-facing UI strings only (via the
  i18n catalogs).
- **Formatting & linting**: Biome (`biome.json`) is the single formatter and
  primary linter. Its rules are strict (`noExplicitAny`, `noNonNullAssertion`,
  cognitive complexity ≤ 15, `noConsole`, …). Fix violations in code, never
  disable a rule; a false positive gets a per-line `biome-ignore` with a
  rationale. ESLint covers only what Biome cannot (type-aware TS, React
  hooks, Playwright).
- **UI text** lives in i18n catalogs (`client/src/i18n/locales/`), Polish by
  default, with an English catalog; `client/src/i18n/locales.test.ts` enforces
  key parity between languages.
- **API contract** lives in `shared/schemas.ts` (zod): types are derived from
  schemas, so runtime validation and static types cannot drift.
- **Server-side data from the network**: parse, don't trust. Narrow request
  inputs (see `server/src/routes/http.ts`, `validation.ts`).
- **Tests**: every behavior change ships with tests. The server integration
  suites (real Elasticsearch/yt-dlp) are env-gated
  (`RUN_ES_INTEGRATION`, `RUN_YTDLP_INTEGRATION`) and skipped by default.

## Dependency version holds

Dependabot deliberately ignores some updates (`.github/dependabot.yml`) ,
upgrade these together, manually, when the time comes:

- **`typescript` (semver-major)**: TS 7 breaks the test toolchain first
  (ts-jest peer range, vitest plugins). Upgrade TS + ts-jest + eslint
  toolchain in one PR. Same history for **zod** (4.x API migration done
  manually) and **react-window** (v2 API migration done manually).
- **`@types/node` (semver-major)**: the runtime is pinned to **Node 22**
  (`.nvmrc`, Docker images); type majors must follow a Node upgrade, not
  lead it. Node 24 is a candidate for the next runtime bump (Node 22 EOL is
  April 2027). Then bump `@types/node` to match in the same change.

## Pull requests

1. Open an issue first (or comment on an existing one) for anything larger
   than a trivial fix. Discuss before building.
2. Branch off `main`, keep commits focused.
3. Run the full gate list above locally.
4. PRs are linted/typechecked/tested in CI; the e2e suite runs on every PR.
   Reviewers are humans. Small, well-described PRs land fastest.

## Project layout

```
server/            Express 5 + ES + download queue (yt-dlp) + OpenAI summaries
client/            React 19 + Vite UI (i18n pl/en, Playwright e2e)
chrome-extension/  MV3 extension: enqueue videos from YouTube (SSE progress)
shared/            zod API contract + helpers shared by server and extension
```

See [docs/API.md](docs/API.md) for the API reference and
[docs/architecture/](docs/architecture/) for the architecture map.
