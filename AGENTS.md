# AGENTS.md

Guidance for AI agents (and humans) working on this repository.

## Repo shape

Monorepo of **four separate npm packages** — no npm workspaces:

| dir                 | what                                                        | test runner         |
| ------------------- | ----------------------------------------------------------- | ------------------- |
| `server/`           | Express 5 + Elasticsearch + yt-dlp queue + OpenAI summaries | jest                |
| `client/`           | React 19 + Vite UI, i18n pl/en                              | vitest + Playwright |
| `chrome-extension/` | MV3 extension (esbuild)                                     | vitest              |
| `shared/`           | zod API contract + helpers (no package.json)                | —                   |

Node 22 (`.nvmrc`), npm 10.9.3 (pinned in `packageManager`).

## Commands

Run everything from the repo root unless noted:

```bash
npm run install:ci        # npm ci for all four packages (CI/local reset)
npm run dev               # server :3001 + client :3000
npm run lint              # biome check + hardcoded-Polish scan + tsconfig strictness check
npm run lint:types        # eslint --max-warnings 0 (type-aware & React/Playwright rules)
npm run lint:scripts      # tsc --noEmit over scripts/ (checkJs)
npm run test:scripts      # node --test for repository-invariant scripts
npm run knip              # unused files/deps
npm run lint:deps         # dependency-cruiser architecture rules
npm run typecheck         # server + client + extension
npm test                  # all unit tests
cd client && npm run test:e2e  # Playwright (mocked API)
```

Full verification one-liner:

```bash
npm run format:check && npm run lint && npm run lint:types && npm run lint:scripts && npm run test:scripts && npm run knip && npm run lint:deps && npm run typecheck && npm test && cd client && npm run test:e2e
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

`npm run lint:deps` (dependency-cruiser) enforces, on pain of CI failure:

- no circular imports;
- `shared/` is a leaf (imports nothing from `server`, `client`,
  `chrome-extension`);
- the three apps never import from each other — they talk through `shared/`
  and HTTP.

## Gotchas

- **Root `npm ci` matters**: `shared/*.ts` resolves `zod` from the repo root,
  so CI installs the root package first (`npm run install:ci`).
- **E2E queue mock**: the mocked queue endpoint is matched by **regex**
  (`/\/api\/folder\/queue/`); a naive glob like `queue*` misses `/queue/pause`,
  and `includes('pause')` matches the query string `?paused=0`.
- **jest-dom 7** does not support computed-style assertions (e.g. `toHaveStyle`
  against stylesheet rules) — assert what the component renders, or use
  `getComputedStyle` where truly needed.
- **Major-version holds**: Dependabot ignores semver-major bumps for
  `typescript`, `zod` and `react-window` (API migrations needed first).
- **No workspaces**: each package has its own `package-lock.json` and
  `node_modules`; run npm commands per package or via the root wrappers.

## Workflow

`main` is protected: every change is a branch → PR → **squash merge**
(ruleset-enforced). Commits must already pass commitlint locally.
