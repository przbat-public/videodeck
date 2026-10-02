# Retire Jest: run the server suite on Vitest

## Objective

The server suite runs on Vitest, the runner the client and the extension already use, so the repository
carries one runner, one mocking API and one coverage provider instead of two.

## Non-goals

- No new server tests and no behavior change in `server/src`. The 40 files that exist are the
  specification: a test that fails after the port is a port bug, not a test to relax.
- The client and the extension keep their configs. Playwright stays the thin mocked browser layer.
- The server build stays CommonJS (`tsconfig.build.json` untouched) and `shared/schemas.ts` does not move.
- No switch to `node:test`, and no rewrite of the test style itself (no `test.each` conversions, no
  describe nesting cleanup).

## Commands

```bash
pnpm run dev                 # server :3001 + client :3000
pnpm run test                # the unit layer, all three packages
pnpm run test:coverage       # the ratchet that gates the coverage numbers
pnpm run typecheck           # server + client + extension, test files included
pnpm run verify              # the full gate one-liner from AGENTS.md
cd server && pnpm run test:integration        # Elasticsearch, needs RUN_ES_INTEGRATION=1
cd server && pnpm run test:ytdlp-integration  # the yt-dlp argument templates
```

The script names stay as they are; only what they call changes.

## Structure

- `server/`: `jest.config.js` goes, `vitest.config.ts` arrives, the five test scripts switch to `vitest`,
  `jest`, `ts-jest` and `@types/jest` leave `devDependencies`, `vitest` and `@vitest/coverage-v8` join
  at the ranges the client already pins. `tsconfig.json` swaps `types: ["node", "jest"]` for
  `["node", "vitest/globals"]`.
- 21 of the 40 test files mention the `jest` namespace directly (318 call sites). The other 19 use only
  globals and need no edit.
- `test-infra/src/deepServerTestEnv.ts`: the `typeof jest` probe and its local `declare const jest`
  go away, leaving one loader path. That file exists to serve both runners, and after this change both
  consumers are Vitest.
- `.github/workflows/`: the unit-tests matrix keeps `pnpm run test`, the server integration job drops
  `npx jest`, the nightly shuffle drops `pnpm exec jest --randomize`.
- Prose that names the runner: `README.md`, `docs/README.pl.md`, `docs/DEVELOPMENT.md`, `AGENTS.md`,
  `.agents/references/testing-patterns.md`, the `test-driven-development`, `ci-cd-and-automation` and
  `debugging-and-error-recovery` skills, `.agents/personas/test-engineer.md`.

## Contract

Nothing in `shared/schemas.ts`, no i18n key, no queue or SSE change. The only visible difference is a
developer running one runner instead of two.

## Style

Biome and strict TS unchanged. Both new dependencies are dev-only and already in the lockfile through
`client/`, so the install graph does not widen. `dependency-cruiser` boundaries and the security
invariants stay untouched. `pnpm run knip` has to stay clean after the removals.

## Testing

The suite is the proof, so the port runs file by file with a green run after each one. The pilot is
`services/downloadQueue.test.ts`: fake timers, module mocks and real queue instances in one file, which
is the hardest mix the port can meet. Then services, then routes, utils and the integration files.

One acceptance criterion per layer:

| Criterion | Test that proves it |
| --- | --- |
| The port keeps behavior | the converted file's own suite under `pnpm run test` |
| The deep backend still boots under Vitest | `src/integration/deepServer.integration.test.ts` |
| Real Elasticsearch still answers | `pnpm run test:integration` |
| The ratchet still bites | `pnpm run test:coverage` fails when a floor is raised past the measured number |
| Test files stay type-checked | `pnpm run typecheck` fails on a deliberate type error planted in one converted file |

Coverage needs a decision, not a copy. ts-jest measures with istanbul and Vitest measures with v8, so the
four numbers will move. The floors are a ratchet against regressions, so the PR records the measured
before and after per metric and commits the new floors from a full run. Nothing drops without that
sentence in the PR body.

ts-jest type-checked every file as it ran it. Vitest strips types and does not check, so `pnpm run
typecheck` becomes the only guard for test files. Its `tsconfig.json` already includes `src/**/*`,
which the planted-error check above confirms.

## Boundaries and risks

- `jest.requireActual` is synchronous, `vi.importActual` returns a promise. 16 sites in 9 files, and
  every factory around them becomes async.
- A `vi.mock` factory cannot read a variable from the file scope unless the test hoists it with
  `vi.hoisted`. 30 factories to read one by one; the pilot settles the pattern the rest follow.
- Fake timers: 19 `advanceTimersByTimeAsync` calls in 6 files map straight across, but Vitest fakes a
  shorter list of APIs by default than Jest does, so a test that depends on a faked `Date` or
  `performance` has to name it.
- Three test files read fixtures through `__dirname`. Vite shims it and `test-infra` already leans on
  that shim, but it stays on the first-run checklist.
- The v8 provider reports nothing for a file no test imports unless `coverage.include` names it, so the
  include list mirrors today's `collectCoverageFrom` with explicit excludes for `src/test-utils.ts` and
  `src/test-env.ts`.
- What the change must not do: leave both runners in the tree after the merge, weaken an assertion to
  make the port pass, widen `ALLOWED_EXTRA_ARGS`, or add a runtime dependency.

## Acceptance criteria

1. `cd server && pnpm run test` runs all 40 files on Vitest, green locally and in the unit-tests job.
2. `jest`, `ts-jest` and `@types/jest` are gone from `server/package.json` and from the lockfile for
   that workspace, and no `jest.*` call survives under `server/src`.
3. `pnpm run test:coverage` fails below the committed floors, and the PR records the measured numbers.
4. The server integration job and the nightly shuffle run on Vitest.
5. `test-infra/src/deepServerTestEnv.ts` holds one loader path and no `typeof jest` probe.
6. Docs, `AGENTS.md` and the agent references name Vitest only, with a CHANGELOG entry under
   _Unreleased_.
7. `pnpm run verify` is green.

## Migration outline

One branch, two commits. The first adds `vitest.config.ts` and the dependencies and converts the pilot
file, leaving Jest in charge of everything else so that commit is independently runnable. The second
converts the remaining 20 files, deletes Jest and its config, simplifies the test-infra loader, moves
CI and the nightly job, refreshes the prose and commits the recalibrated floors. The PR links this plan.
