# AGENTS.md

Guidance for AI agents (and humans) working on this repository.

## Repo shape

Monorepo with **pnpm workspaces** (`pnpm-workspace.yaml`), like vita-tracker:

| dir                 | what                                                             | test runner                       |
| ------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `server/`           | Express 5 + Elasticsearch + yt-dlp queue + OpenAI summaries      | jest + deep integration           |
| `client/`           | React 19 + Vite UI, i18n pl/en                                   | vitest + integration + Playwright |
| `chrome-extension/` | MV3 extension (esbuild)                                          | vitest                            |
| `shared/`           | zod API contract + helpers (the `@videodeck/shared` package)     |                                  |
| `test-infra/`       | shared test infrastructure (fake ES, mock OpenAI, backend env)   | imported by both test suites      |

Node 24 (`.nvmrc`, mirrored by the `engines` fields), pnpm 12.4.2 (pinned in
`packageManager`).

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
pnpm run typecheck           # server + client + extension (+ client tests tsconfig)
pnpm run test                # all unit tests
pnpm run test:integration    # client integration: real <App /> against the real backend, in-process
cd client && pnpm run test:e2e  # Playwright (mocked API — the thin browser layer)

Full verification one-liner:

```bash
pnpm run verify
```

(`verify` chains format, lint, lint:types, lint:scripts, test:scripts,
knip, lint:deps, humanizer:gate, typecheck, test, test:integration and
the client e2e suite, in that order.)

## Linting (Biome + ESLint)

- **Biome** (`biome.json`, v2) is the formatter and the primary linter:
  single quotes, line width 120, strict rules: `noExplicitAny`,
  `noNonNullAssertion`, `noConsole`, cognitive complexity ≤ 15, `noForEach`,
  empty blocks banned. **Fix violations in code, never disable a rule.**
  A genuine false positive gets a per-line `biome-ignore` with an English
  rationale; changing severity in `biome.json` is off the table.
- `noConsole` exceptions are deliberately narrow: `scripts/**`,
  `chrome-extension/src/**`, `server/src/utils/logger.ts` and
  `client/src/utils/logError.ts`.
- **ESLint** stays only for what Biome cannot do: `@typescript-eslint`,
  react-hooks, react-refresh and Playwright rules (`lint:types`), with
  `eslint-config-biome` last so the two linters never fight.
- **pnpm** (workspaces) manages dependencies; `allowBuilds` in `pnpm-workspace.yaml`
  whitelists the packages allowed to run postinstall scripts.

## Language

**All commit messages, PR titles/descriptions, code comments, docs and issue
text are written in English.** Polish appears only in user-facing UI strings,
and only through the i18n catalogs (`client/src/i18n/locales/`). commitlint
enforces Conventional Commits with lowercase subjects.

**Prose follows the humanizer skill** (`.agents/skills/humanizer/SKILL.md`):
no AI-writing tells in docs. No em dashes, none of the skill's tiered
vocabulary words, varied sentence length. The vendored metrics CLI
(`scripts/humanizer/`, MIT) scores the docs in CI against a committed
baseline: `pnpm run humanizer:gate`.

**UI follows the design contract** (`DESIGN.md`): tokens from
`client/src/index.css` only, the shared primitives
(`client/src/components/ui/`), dark-mode parity, a11y and i18n rules. The
`.agents/skills/ui-design` skill turns that contract into a checklist for
any UI change.

## Skills

Repo-scoped skills live in `.agents/skills/` and load into the session
skill catalog automatically. They are workflows, not reference prose: each
one has steps, checkpoints, an anti-rationalization table and verification
gates. This file stays short on purpose; the detail lives in the skills,
loaded on demand. Two repo-invariant scripts keep it honest:
`scripts/check-skills.test.mjs` validates the frontmatter of every skill
and the no-em-dash prose rule across `.agents/`, and
`scripts/check-context.test.mjs` pins every command and path this file
references to the real repo. Shared checklists live in
`.agents/references/`.

- `humanizer` — prose rules and the AI-tell gate
- `ui-design` — the DESIGN.md token, component and a11y checklist for UI work
- `responsive-design` — responsive layout contract (breakpoints, touch
  targets, hover rules) and the audit workflow with the static UX scanner
- `test-driven-development` — RED → GREEN → REFACTOR on this repo's test commands
- `code-review-and-quality` — five-axis PR review with severity labels
- `debugging-and-error-recovery` — reproduce, localize, reduce, fix, guard
- `security-and-hardening` — the security invariants as an audit workflow
- `spec-driven-development` — PRD before code for larger features (docs/plans/)
- `planning-and-task-breakdown` — specs into small, verifiable tasks
- `incremental-implementation` — vertical slices with safe defaults
- `interview-me` — one question at a time to pin down the ask
- `git-workflow-and-versioning` — branch → PR → squash discipline
- `ci-cd-and-automation` — the CI checks and the shift-left gate
- `shipping-and-launch` — release and rollback checklists
- `deprecation-and-migration` — code as liability, holds and zombie removal
- `archify` — validated architecture diagrams in docs/architecture/
- `using-agent-skills` — routes incoming work to the right skill

Review personas live in `.agents/personas/` (code reviewer, test engineer,
security auditor, web performance auditor); invoke them as subagent
playbooks for PR reviews and audits.

## Definition of done

- Tests cover the change; the failing test was written first (RED → GREEN).
- UI text via i18n keys, pl + en parity (enforced by `locales.test.ts`).
- API changes are reflected in `shared/schemas.ts`.
- User-visible changes get a `CHANGELOG.md` entry under _Unreleased_.
- Full verification one-liner above is green.
- English-only throughout.

Four working principles sit underneath the checklist:

- **Understand what you write.** No pasted block whose behavior you cannot
  explain line by line.
- **Keep the diff minimal.** The smallest change that satisfies the tests
  and the spec; no speculative branches.
- **Prove before you claim.** Green tests and the gate, never "it works on
  my machine".
- **Verify before you report.** Check the actual file, log or output named
  in the claim before calling a task done.

## i18n rules

- Assert by **key** (`t('playlist.add')`), never by Polish literals.
- No hardcoded Polish strings in `client/src` or `chrome-extension/src`;
  `scripts/check-hardcoded-polish.mjs` (part of `pnpm run lint`) fails the
  build on them. The `polish-ok` file marker is the deliberate escape hatch.

## Security invariants (server)

- **Host allowlist**: outbound fetches must go through the `ALLOWED_HOSTS`
  validation (`server/src/config.ts`, `server/src/routes/http.ts`); never
  pass user-controlled URLs straight to `fetch`.
- **No SSRF**: internal/loopback addresses stay blocked.
- **Forbidden yt-dlp flags**: `--cookies`, `--load-cookies`,
  `--cookies-from-browser` (cookie-jar exfiltration) are rejected in
  `server/src/services/folderConfig.ts`; do not remove them.
- **Secrets**: only `server/.env` (git-ignored); never commit real values.

## Type safety

- Strict TS everywhere; `tsconfig.base.json` flags are pinned by
  `scripts/check-tsconfig-strict.mjs`. Changes to the base flags need a
  matching update of that script's expectations.
- Server data from the network: parse with zod (`shared/schemas.ts`), never
  `as`-cast.

## Architecture boundaries

`pnpm run lint:deps` (dependency-cruiser) enforces, on pain of CI failure:

- no circular imports;
- `shared/` is a leaf (imports nothing from any app or `test-infra`);
- the three apps never import from each other; they talk through `shared/`
  and HTTP;
- `test-infra/` knows the server it tests (it boots the real app in-process)
  but never the UIs;
- apps import `test-infra` **from test files only** (`@videodeck/test-infra/*`,
  a workspace dependency resolved through its package `exports`), never from
  production code.

The deep testing strategy is the vita-tracker one: the client integration
suite (`client/src/__tests__/integration/`) renders the real `<App />` against
the REAL backend booted in-process by `test-infra` (fake Elasticsearch, mock
OpenAI, fake yt-dlp, seeded temp folders). The only patch is a fetch rewrite.
Playwright stays the thin mocked-API browser layer (`client/e2e/`).

## Gotchas

- **pnpm lockfile**: one `pnpm-lock.yaml` for the workspace; install with
  `pnpm install --frozen-lockfile` (CI and Docker alike). `shared/*.ts`
  resolves `zod` from the workspace root package.
- **E2E queue mock**: the mocked queue endpoint is matched by **regex**
  (`/\/api\/folder\/queue/`); a naive glob like `queue*` misses `/queue/pause`,
  and `includes('pause')` matches the query string `?paused=0`.
- **jest-dom 7** does not support computed-style assertions (e.g. `toHaveStyle`
  against stylesheet rules). Assert what the component renders, or use
  `getComputedStyle` where truly needed.
- **Major-version holds**: Dependabot ignores semver-major bumps for
  `typescript`, `zod` and `react-window` (API migrations needed first).
- **jest + the shared test infra**: `@videodeck/test-infra/*` and
  `@videodeck/shared/*` resolve through the pnpm workspace symlinks and each
  package's `exports` (no tsconfig paths, jest mapper or vite aliases — the
  dependency-cruiser config follows those symlinks). The env helper imports
  the server app only AFTER setting the environment. Keep that ordering.

## Workflow

`main` is protected: every change is a branch → PR → **squash merge**
(ruleset-enforced). Commits must already pass commitlint locally.
Releases follow `RELEASING.md`; the Docker stack lives in
`docker-compose.yml` + `docs/DEPLOYMENT.md`.
