---
name: test-driven-development
description: Runs the red-green-refactor loop on this repo's real test commands, with the Prove-It pattern for bug fixes and new assertions. Use when implementing logic, fixing a bug or changing behavior in videodeck (server, client or extension).
user-invocable: true
---

# Test-Driven Development

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Write a failing test before the code that makes it pass. For bug fixes,
reproduce the bug with a test before touching the fix. Tests are proof;
"seems right" is not done. videodeck already runs four test layers, so the
loop always uses the repo's own commands, never a guessed default.

## When to Use

- Implementing any new logic or behavior
- Fixing any bug (the Prove-It pattern)
- Changing existing functionality or edge-case handling

Skip it only for pure config, docs or static content changes.

## The fixed stack

| Layer | Command | Focused run |
| --- | --- | --- |
| Server (jest) | `cd server && pnpm run test` | `cd server && pnpm run test -t "pattern"` |
| Client (vitest) | `cd client && pnpm run test:run` | `cd client && pnpm run test:run -t "pattern"` |
| Extension (vitest) | `cd chrome-extension && pnpm run test` | `cd chrome-extension && pnpm run test:run -t "pattern"` |
| Client integration | `pnpm run test:integration` | `pnpm run test:integration -t "pattern"` |
| Browser e2e | `cd client && pnpm run test:e2e` | Playwright, mocked API |

Pass the filter **without** `--`. pnpm 12 forwards the separator literally, so
`pnpm run test:integration -- -t "name"` runs the whole suite and reports
green while proving nothing about the one test you meant.

Run the focused command during the loop, the full suite before finishing,
and the full gate one-liner from `AGENTS.md` before opening a PR.

## The TDD cycle

**RED.** Write the test first. It must fail; a test that passes on the first
run proves nothing. Follow neighboring test files for style, and follow the
house rules: assert by i18n key in client tests, use the seeded fixtures in
`server/src/test/fixtures/`, never hit the real network or Elasticsearch.

**GREEN.** Write the minimum code that makes it pass. No speculative
branches, no future-proofing.

**REFACTOR.** Clean up with the tests green: extract helpers, improve
names, remove duplication. Re-run after every refactor step.

## The Prove-It pattern (bug fixes)

Do not start by fixing the bug. Start with a test that demonstrates it:

1. Write a reproduction test; watch it fail.
2. Implement the smallest fix that flips it green.
3. Run the full suite plus the integration layer that covers the area.
4. The regression test stays in the suite forever.

For complex bugs, let a subagent write the reproduction test from the bug
description alone, then verify it fails before you fix.

Prove-It covers new assertions too, not just fixes. Before you trust an
assertion, break the behaviour it claims to cover and watch it go red:

1. Name the production line the assertion is supposed to catch.
2. Mutate it: remove the click the wait follows, drop the retry it counts,
   re-arm the timer it advances, widen the guard it pins.
3. Run the focused command and read the failure. A timeout on a different
   assertion is not proof; the one you wrote has to be the one that failed.
4. Restore the line, re-run green, and say in the report what you mutated
   and what the failure said.

An assertion nobody has seen fail is a comment with extra steps. The
`client/src/__tests__/integration/` journeys carry the worst version of this
trap: the list already renders the card title, so a heading query after a
click is satisfied before the navigation happens.

## The timing ladder

A test waits for a fact, not for a duration. Take the highest rung that can
express the fact:

1. **An app-emitted signal.** The route the router reports, the request the
   fake Elasticsearch logged, the row the app re-rendered, the file the fake
   yt-dlp wrote. This is the default, and it is the only rung a journey
   should need.
2. **A poll with a budget.** `waitFor(() => expect(...), { timeout })` for a
   state that only shows up as a side effect, or a named helper that polls a
   predicate. Interactive suites use it sparingly; a poll that never fails
   loudly is a hang waiting to happen.
3. **A fixed delay only with a named reason.** The comment has to name the
   condition it waits for and the constant it clears ("past SearchBar's
   `DEBOUNCE_DELAY` window, so no commit may follow"). Prefer advancing a fake
   clock over sleeping through a real one.

Supporting rules:

- Budgets are named constants. `sleep(350)` and `{ timeout: 1234 }` tell the
  next reader nothing; `DEBOUNCE_DELAY + 1` says what would make the number
  wrong. Import the constant from the code under test when it exports one.
- A fake never encodes a timing assumption about its consumer. The fake
  answers when asked, it does not sleep "long enough" for the app to notice.
- `jest.useFakeTimers()` (or `vi.useFakeTimers()`) plus an explicit advance is
  the default for debounce, backoff and watchdog tests. Watch out for the two
  traps: interactions driven by `userEvent` deadlock under fake timers (use
  `fireEvent`, or fake only the window), and a genuine zero-delay interval
  spins the fake clock instead of failing, so keep the timers the code arms
  strictly positive when a test advances past them.

## Fakes and mocks

Mock at a boundary you do not own: Elasticsearch, OpenAI, yt-dlp, `fetch`,
the clock, the browser. Never the app's own modules. A test that mocks
`videoScanner` or `downloadQueue` proves the mock was called, not that the
feature works.

When a mocked app service is unavoidable, the test says in a comment which
behaviour that hides. "Mocks the index writer because this test is about the
retry count" tells the reader what is not proven here.

Every fake carries three things:

- a fidelity note next to its code, naming what it models and what it leaves
  to the real dependency (`test-infra/src/fakeElasticsearch.ts` is the model);
- its own tests over its own surface, one per modelled behaviour
  (`server/src/test/fakeElasticsearch.test.ts`);
- a real-dependency twin in CI for the behaviour the fake approximates
  (`RUN_ES_INTEGRATION=1 jest src/services/elasticsearch.integration.test.ts`
  against a real cluster), so a fake that drifts cannot stay green forever.

## Which layer to pick

- Pure logic with no I/O: a unit test (jest or vitest), milliseconds.
- A boundary crossed (API route, file system, queue state): server
  integration via supertest with fakes, or the in-process client
  integration when UI and backend must meet.
- A critical user flow end to end: Playwright, sparingly.

Prefer real implementations, then fakes, then stubs, then interaction mocks.
videodeck's fakes already sit at the boundaries: the fake Elasticsearch
server, the mock OpenAI server and the fake yt-dlp in `scripts/fake-bin/`
(pointed to by `YTDLP_PATH`). Add another fake when a new external boundary
appears; the three obligations it owes are under "Fakes and mocks" above.

## Writing good tests

- Assert on state and outcomes, not on internal call sequences.
- DAMP over DRY: each test reads like a spec without tracing shared
  helpers.
- Arrange, act, assert: three visible blocks.
- One assertion per concept; descriptive names ("marks the download
  finished locally when the queue drains", not "works").
- Every test stands on its own. `-t "its name"` has to pass with no other
  test in front of it: seed the folder, set the queue or clock state and
  restore it in a `finally`. "Continues the previous test" is not a
  precondition, it is a hidden dependency.
- After an interaction, assert a state only the new page has. In jsdom the
  locator vocabulary matters: a bare role plus name that an item on the
  previous page also satisfies (the card title, the row label) resolves
  before the navigation, so it cannot fail. Wait on the route, on an element
  only the new page renders, or on the previous page's form being gone.
- jest-dom 7 has no computed-style assertions; assert what the component
  renders instead.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I will add tests after it works" | Post-hoc tests check implementation, not behavior. |
| "This is too simple to test" | Simple code grows. The test documents the contract. |
| "I tested it manually" | Manual checks do not persist and do not run in CI. |
| "Tests slow me down" | They pay back on every later change. |
| "The assertion passes, so it proves the behavior" | Only if you watched it fail without that behavior. |
| "The sleep is short" | A short guess is still a guess. Advance a fake clock, or wait for a signal. |
| "The suite is green together" | Order-dependent tests hide which one broke. Each passes with `-t`. |
| "Mocking our own service keeps the test small" | It hides the integration the test exists for. Mock the boundary you do not own. |

## Red Flags

- Code merged with no corresponding test
- A test that passed on the first run
- A bug fix without a reproduction test
- An assertion nobody has seen fail
- `sleep(`, `waitForTimeout(` or `.only(` in a test file
- A journey test that only passes when the file runs in order
- Skipped or disabled tests to make the suite pass
- Re-running the same command on unchanged code

## Verification

- [ ] Every new behavior has a test written before the code
- [ ] Every new assertion was shown to fail before it was trusted
- [ ] The focused run passed during the loop
- [ ] Every journey test passed alone with `-t "name"`
- [ ] The full suite for the touched workspace passed
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] No fixed sleep or `waitForTimeout` (the hygiene gate enforces it)
- [ ] Coverage did not decrease (the ratchet enforces it in CI)
