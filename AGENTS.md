# AGENTS.md

Guidance for AI agents (and humans) working on this repository.

## Repo shape

Monorepo — **pnpm workspaces** (`pnpm-workspace.yaml`), like vita-tracker:

| dir                 | what                                                             | test runner                       |
| ------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `server/`           | Express 5 + Elasticsearch + yt-dlp queue + OpenAI summaries      | jest + deep integration           |
| `client/`           | React 19 + Vite UI, i18n pl/en                                   | vitest + integration + Playwright |
| `chrome-extension/` | MV3 extension (esbuild)                                          | vitest                            |
| `shared/`           | zod API contract + helpers (imported via the `@shared/*` alias)  | —                                 |
| `test-infra/`       | shared test infrastructure (fake ES, mock OpenAI, backend env)   | imported by both test suites      |

Node 22 (`.nvmrc`), pnpm 10.30.1 (pinned in `packageManager`; corepack picks it up).

## Commands

Run everything from the repo root unless noted:

```bash
pnpm run install:ci          # frozen install of the whole workspace (CI/local reset)
pnpm run dev                 # server :3001 + client :3000
pnpm run lint                # biome check + hardcoded-Polish scan + tsconfig strictness check
pnpm run lint:types          # eslint --max-warnings 0 (type-aware & React/Playwright rules)
pnpm run lint:scripts        # tsc --noEmit over scripts/ (checkJs)
pnpm run test:scripts        # node --test for repository-invariant scripts
pnpm run knip                # unused files/deps
pnpm run lint:deps           # dependency-cruiser architecture rules
pnpm run typecheck           # server + client + extension (+ client integration tsconfig)
pnpm run test                # all unit tests
pnpm run test:integration    # client integration: real <App /> against the real backend, in-process
cd client && pnpm run test:e2e  # Playwright (mocked API — the thin browser layer)

Full verification one-liner:

```bash
pnpm run format:check && pnpm run lint && pnpm run lint:types && pnpm run lint:scripts && pnpm run test:scripts && pnpm run knip && pnpm run lint:deps && pnpm run typecheck && pnpm run test && pnpm run test:integration && cd client && pnpm run test:e2e
```

## Linting (Biome + ESLint)

- **Biome** (`biome.json`, v2) is the formatter and the primary linter:
  single quotes, line width 120, strict rules — `noExplicitAny`,
  `noNonNullAssertion`, `noConsole`, cognitive complexity ≤ 15, `noForEach`,
  empty blocks banned. **Fix violations in code — never disable a rule.**
  A genuine false positive gets a per-line `biome-ignore` with an English
  rationale; changing severity in `biome.json` is off the table.
- `noConsole` exceptions are deliberately narrow: `scripts/**`,
  `chrome-extension/src/**`, `server/src/utils/logger.ts` and
  `client/src/utils/logError.ts`.
- **ESLint** stays only for what Biome cannot do: `@typescript-eslint`,
  react-hooks, react-refresh and Playwright rules (`lint:types`), with
  `eslint-config-biome` last so the two linters never fight.
- **pnpm** (workspaces) manages dependencies; `pnpm.onlyBuiltDependencies`
  whitelists the packages allowed to run postinstall scripts.

## Language

**All commit messages, PR titles/descriptions, code comments, docs and issue
text are written in English.** Polish appears only in user-facing UI strings,
and only through the i18n catalogs (`client/src/i18n/locales/`). commitlint
enforces Conventional Commits with lowercase subjects.

## Definition of done

- Tests cover the change; the failing test was written first (RED → GREEN).
- UI text via i18n keys, pl + en parity (enforced by `locales.test.ts`).
- API changes are reflected in `shared/schemas.ts`.
- User-visible changes get a `CHANGELOG.md` entry under _Unreleased_.
- Full verification one-liner above is green.
- English-only throughout.

## i18n rules

- Assert by **key** (`t('playlist.add')`), never by Polish literals.
- No hardcoded Polish strings in `client/src` or `chrome-extension/src` —
  `scripts/check-hardcoded-polish.mjs` (part of `npm run lint`) fails the
  build on them. The `polish-ok` file marker is the deliberate escape hatch.

## Security invariants (server)

- **Host allowlist**: outbound fetches must go through the `ALLOWED_HOSTS`
  validation (`server/src/config.ts`, `server/src/routes/http.ts`); never
  pass user-controlled URLs straight to `fetch`.
- **No SSRF**: internal/loopback addresses stay blocked.
- **Forbidden yt-dlp flags**: `--cookies`, `--load-cookies`,
  `--cookies-from-browser` (cookie-jar exfiltration) are rejected in
  `server/src/services/folderConfig.ts` — do not remove them.
- **Secrets**: only `server/.env` (git-ignored); never commit real values.

## Type safety

- Strict TS everywhere; `tsconfig.base.json` flags are pinned by
  `scripts/check-tsconfig-strict.mjs` — changes to the base flags need a
  matching update of that script's expectations.
- Server data from the network: parse with zod (`shared/schemas.ts`), never
  `as`-cast.

## Architecture boundaries

`pnpm run lint:deps` (dependency-cruiser) enforces, on pain of CI failure:

- no circular imports;
- `shared/` is a leaf (imports nothing from any app or `test-infra`);
- the three apps never import from each other — they talk through `shared/`
  and HTTP;
- `test-infra/` knows the server it tests (it boots the real app in-process)
  but never the UIs;
- apps import `test-infra` **from test files only** (`@videodeck/test-infra/*`,
  a workspace dependency) — never from production code.

The deep testing strategy is the vita-tracker one: the client integration
suite (`client/src/__tests__/integration/`) renders the real `<App />` against
the REAL backend booted in-process by `test-infra` (fake Elasticsearch, mock
OpenAI, fake yt-dlp, seeded temp folders) — the only patch is a fetch rewrite.
Playwright stays the thin mocked-API browser layer (`client/e2e/`).

## Gotchas

- **pnpm lockfile**: one `pnpm-lock.yaml` for the workspace; install with
  `pnpm install --frozen-lockfile` (CI and Docker alike). `shared/*.ts`
  resolves `zod` from the workspace root package.
- **E2E queue mock**: the mocked queue endpoint is matched by **regex**
  (`/\/api\/folder\/queue/`); a naive glob like `queue*` misses `/queue/pause`,
  and `includes('pause')` matches the query string `?paused=0`.
- **jest-dom 7** does not support computed-style assertions (e.g. `toHaveStyle`
  against stylesheet rules) — assert what the component renders, or use
  `getComputedStyle` where truly needed.
- **Major-version holds**: Dependabot ignores semver-major bumps for
  `typescript`, `zod` and `react-window` (API migrations needed first).
- **jest + the shared test infra**: `@videodeck/test-infra/*` maps to
  `../test-infra/src/*` (jest `moduleNameMapper`, vite alias, tsconfig paths).
  The env helper imports the server app only AFTER setting the environment —
  keep that ordering.

## Workflow

`main` is protected: every change is a branch → PR → **squash merge**
(ruleset-enforced). Commits must already pass commitlint locally.
Releases follow `RELEASING.md`; the Docker stack lives in
`docker-compose.yml` + `docs/DEPLOYMENT.md`.
