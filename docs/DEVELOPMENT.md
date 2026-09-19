# Development reference

Contributor reference: linting and formatting rules, the test matrix, the
strict TypeScript flags, frontend architecture decisions and the full
project layout. The day-to-day commands live in the README; AGENTS.md and
CONTRIBUTING.md hold the working agreements.

## Linting and Formatting

The project uses Biome (formatter + linter) and ESLint (type-aware rules)
to keep the code consistent.

Biome's `biome.json` in the root directory is the single source of truth for
formatting (single quotes, line width 120) and for the strict lint rules
(`noExplicitAny`, `noNonNullAssertion`, cognitive complexity ≤ 15,
`noConsole`, …). ESLint's flat config (`eslint.config.mjs`) covers `server/`,
`client/`, `shared/`, and `chrome-extension/src/` (the generated `*.js` files
of the extension are ignored) and carries only the rules Biome cannot ,
type-aware TypeScript checks, React hooks and Playwright. Flat config only
lints files below its own directory, and `shared/` sits outside both
workspaces, which is why lint and formatting are run from the root. The
configuration tells the React plugin that the project targets React 19
(`settings['react-x']`). Components accept `ref` as a regular prop (without
`forwardRef`).

### Checking the code (lint)

```bash
pnpm run lint          # biome check + repository-invariant scripts
pnpm run lint:types    # eslint --max-warnings 0 (type-aware, React, Playwright)
```

Lint runs with zero tolerance: every warning fails the run, so the list of
issues cannot grow. Where an indexed access is genuinely safe (e.g. yt-dlp
log lines that never change order), a deliberate `eslint-disable` with
justification is used.

### Auto-fixing errors

```bash
pnpm run lint:fix
```

### Code formatting

```bash
pnpm run format
```

### Checking formatting (without changing files)

```bash
pnpm run format:check
```
## Tests

The project uses **Jest** for the backend and **Vitest** for the frontend and the Chrome extension.

### Running tests

**All projects:**

```bash
pnpm test
```

**Backend only:**

```bash
cd server && pnpm test
cd server && pnpm run test:watch  # Watch mode
cd server && pnpm run test:coverage  # With coverage report
```

**Frontend only:**

```bash
cd client && pnpm test  # Watch mode
cd client && pnpm run test:run  # One-off run
cd client && pnpm run test:ui  # Graphical interface
cd client && pnpm run test:coverage  # With coverage report
```

**Chrome extension only:**

```bash
cd chrome-extension && pnpm test  # One-off run
cd chrome-extension && pnpm run test:watch  # Watch mode
```

**Integration tests with a real Elasticsearch** (reindex flow with
alias switching, diacritic folding, searching transcripts ,
skipped in the regular `pnpm test`):

```bash
cd server && pnpm run test:integration  # requires a running ES (ELASTICSEARCH_URL)
```

**Integration tests with a real yt-dlp**: download-queue argument templates
checked against the installed binary (`--simulate`, without
downloading; skipped in the regular `pnpm test`):

```bash
cd server && pnpm run test:ytdlp-integration  # requires yt-dlp on PATH
```

**Property-based tests (fast-check)**: parser invariants (VTT, SSE,
yt-dlp progress, YouTube id, runPool) for arbitrary inputs, with automatic
minimization of counterexamples; on the server and extension side.

**End-to-end tests (Playwright)**: the real app (Vite) with the API mocked
at the browser level; no backend and no Elasticsearch. Scenarios:
URL-driven search, "Show more" (pl: „Pokaż więcej") pagination, the details page
with the player and subtitles, the status page:

```bash
pnpm run test:e2e  # first time: cd client && pnpm exec playwright install chromium
```

The suite reuses a server already listening on port 3000, which is convenient
while this app's dev server runs and wrong when another project's does: the
tests then exercise that application. Pass a port to start a fresh one beside
it: `E2E_PORT=3210 pnpm run test:e2e` (the override also disables reuse). The
variable reaches the whole gate, so `E2E_PORT=3210 pnpm run verify` works with
another dev server holding 3000.

Server route tests check responses against contract schemas (`shared/schemas.ts`),
and the VTT parser is pinned by fixtures from real yt-dlp files.

### Test coverage

```bash
# Backend
cd server && pnpm run test:coverage

# Frontend
cd client && pnpm run test:coverage
```

Coverage reports are generated in the `coverage/` folder.

The backend and frontend have coverage thresholds configured (`coverageThreshold` in
`server/jest.config.js`, `test.coverage.thresholds` in `client/vite.config.ts`).
The thresholds sit just below the current level. They are meant to catch
regressions, not to be a goal in themselves. When coverage grows, it is worth
raising them. The Chrome extension has unit tests without thresholds. It is
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
- **Central error handling** - Express 5 forwards rejected handlers to a single middleware (`server/src/app.ts`), so every unhandled error is a consistent JSON 500 and a full log with the route, no try/catch in every handler
- **Contract validation** - the bodies of `POST /api/folder/queue` and `PUT /api/folder/config` are parsed with zod schemas (`server/src/routes/validation.ts`); a validation error is a 400 with the first problem described directly
- **Dependency injection** - `createApp` takes the token and the download queue (`createFolderRouter(queue)`), and the ES client has an injection point. Tests do not reach for module singletons
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

**The shared API contract** lives in the `@videodeck/shared` workspace package: the zod schemas (`schemas.ts`) are the single source of truth for response shapes, and `api.ts` re-exports the types derived with `z.infer` (plus request types and SSE event types). The server, client, and extension import the types as `@videodeck/shared/api`; the client **parses** every response against a schema (parse, don't trust), and the server route tests check responses against the same schemas, so types and validation cannot drift apart. `api.ts` stays types-only (`import type` enforced by ESLint), while `schemas.ts` and `progress.ts` are deliberate runtime modules shared by the server and the extension.

Express routers use `RouteHandler<Params, Response>` from `server/src/routes/http.ts`: path params are derived from the route pattern, `req.body` is typed `unknown` and narrowed with the `readBody`/`readString` helpers, and `res.json()` only accepts the contract type (or `ApiError`). `any` is banned by lint (`no-explicit-any: error`) in code and tests.
## Frontend architecture

A short overview of the client's architectural decisions and what was consciously **not** implemented:

- **StrictMode**: enabled; dev double-renders to catch impure renders.
- **Reducers on `as const`**: action types are `as const` + a union type
  instead of enums (less runtime code, full literal inference in `switch`).
- **`useDebouncedValue`**: a single debounce hook (search phrase and channel filter).
- **Virtualization**: the channel's video list (Status) uses react-window
  (`VariableSizeList`, thousands of rows); the search result grid is a
  responsive grid of variable-height cards, so instead of react-window
  it uses `content-visibility: auto` (the browser skips rendering cards
  off-screen).
- **TanStack Query**: a recommendation, not an implementation. Around 400
  lines of hand-written fetch hooks (useVideoSearch, useVideoDetail, useStatus,
  useDownloadQueue) cover the caching, retries, and synchronization that
  TanStack Query provides out of the box; the migration is worth doing at the
  next larger data refactor, not during small changes.
- **React Compiler**: a recommendation, not an implementation.
  Auto-memoization would remove the manual `memo`/`useCallback`
  (VideoItem, VideoCard, CommentComponent), but it needs verification
  against react-window and react-i18next; enable it as a separate,
  conscious step.

## Developer tooling

- **Shared TypeScript**: `tsconfig.base.json` at the root holds the common
  strictness rules (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess, …);
  client/server/extension inherit them and add only their own options. The
  server has `isolatedModules` (per-file typecheck), and the extension
  typechecks the whole `../shared` directory, not selected files.
- **Husky + commitlint + lint-staged**: `pre-commit` formats and lints
  changed files (biome check --write), `commit-msg` enforces
  the conventional commits convention (`feat:`, `fix:`, `chore(tooling):`, …) ,
  the end of mixed styles in the history.

