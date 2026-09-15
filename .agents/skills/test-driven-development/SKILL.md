---
name: test-driven-development
description: Runs the red-green-refactor loop on this repo's real test commands, with the Prove-It pattern for bug fixes. Use when implementing logic, fixing a bug or changing behavior in videodeck (server, client or extension).
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
| Server (jest) | `cd server && pnpm run test` | `cd server && pnpm run test -- -t "pattern"` |
| Client (vitest) | `cd client && pnpm run test:run` | `cd client && pnpm run test:run -- -t "pattern"` |
| Extension (vitest) | `cd chrome-extension && pnpm run test` | `cd chrome-extension && pnpm run test:run -- -t "pattern"` |
| Client integration | `pnpm run test:integration` | real `<App />` against the real backend in-process |
| Browser e2e | `cd client && pnpm run test:e2e` | Playwright, mocked API |

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

## Which layer to pick

- Pure logic with no I/O: a unit test (jest or vitest), milliseconds.
- A boundary crossed (API route, file system, queue state): server
  integration via supertest with fakes, or the in-process client
  integration when UI and backend must meet.
- A critical user flow end to end: Playwright, sparingly.

Prefer real implementations, then fakes, then stubs, then interaction
mocks. videodeck's fakes already sit at the boundaries: the fake
Elasticsearch server, the mock OpenAI server and the fake yt-dlp in
`scripts/fake-bin/` (pointed to by `YTDLP_PATH`). Add another fake when a
new external boundary appears; do not mock inside the app itself.

## Writing good tests

- Assert on state and outcomes, not on internal call sequences.
- DAMP over DRY: each test reads like a spec without tracing shared
  helpers.
- Arrange, act, assert: three visible blocks.
- One assertion per concept; descriptive names ("marks the download
  finished locally when the queue drains", not "works").
- jest-dom 7 has no computed-style assertions; assert what the component
  renders instead.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I will add tests after it works" | Post-hoc tests check implementation, not behavior. |
| "This is too simple to test" | Simple code grows. The test documents the contract. |
| "I tested it manually" | Manual checks do not persist and do not run in CI. |
| "Tests slow me down" | They pay back on every later change. |

## Red Flags

- Code merged with no corresponding test
- A test that passed on the first run
- A bug fix without a reproduction test
- Skipped or disabled tests to make the suite pass
- Re-running the same command on unchanged code

## Verification

- [ ] Every new behavior has a test written before the code
- [ ] The focused run passed during the loop
- [ ] The full suite for the touched workspace passed
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] Coverage did not decrease (the ratchet enforces it in CI)
