---
name: code-review-and-quality
description: Conducts the five-axis review (correctness, readability, architecture, security, performance) with severity labels before any videodeck PR merges. Use when reviewing a change written by you, another agent or a human.
user-invocable: true
---

# Code Review and Quality

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Every change gets reviewed against five axes before it merges: correctness,
readability, architecture, security, performance. Approve when the change
improves overall code health even if it is not perfect; do not block
because you would have written it differently.

## When to Use

- Before merging any PR, yours included
- After a feature lands, to check the result against the plan
- After any bug fix (review the fix and the regression test together)

## The five axes

1. **Correctness.** Does it do what it claims? Edge cases (empty, null,
   boundary values), error paths beyond the happy path, race conditions in
   queue or SSE code. Do the tests verify the right things?
2. **Readability.** Can a stranger follow it without the author? Names that
   match neighboring code, no nested ternaries, no clever tricks, comments
   only where intent is not obvious.
3. **Architecture.** Does it respect the dependency-cruiser boundaries
   (`shared/` is a leaf, apps never import each other, `test-infra` only
   from test files)? No circular imports. API data parsed with zod in
   `shared/schemas.ts`, never `as`-cast. A new abstraction must remove
   moving parts, not relocate them; a "temporary" branch is permanent debt.
4. **Security.** Defer the deep pass to `security-and-hardening`. At
   minimum: user input validated at boundaries, no secrets, outbound
   fetches through the `ALLOWED_HOSTS` rules, no new yt-dlp flag that
   bypasses the forbidden list.
5. **Performance.** No N+1 queries, no unbounded loops, pagination on list
   endpoints, no pointless re-renders in the client. For structural claims
   run `pnpm run knip` and `pnpm run lint:deps`.

## Severity labels

| Prefix | Meaning | Author action |
| --- | --- | --- |
| *(no prefix)* | Required | Fix before merge |
| **Critical:** | Blocks merge | Security hole, data loss, broken behavior |
| **Nit:** | Optional | May ignore |
| **Optional:** / **Consider:** | Suggestion | Worth considering |
| **FYI** | Informational | No action |

Lead with what matters: one structural problem outweighs ten nits. Order by
correctness and security, then structure, then style.

## Change sizing

Keep changes around 100 lines where possible; 300 is fine for one logical
change; 1000 means split. Watch total file size too: pushing a file past
1000 lines is a signal to extract helpers first. A change that refactors
and adds behavior is two changes. Splitting strategies: stack small
changes, split by file group, or cut a vertical slice.

## Review process (this repo's flow)

1. Understand the intent from the PR description and `CHANGELOG.md`.
2. Read the tests first; they state the intended behavior.
3. Walk the diff with the five axes.
4. Label every finding with a severity prefix.
5. Check the verification story: which gate steps ran, screenshots for UI
   changes, the PR template at `.github/pull_request_template.md` filled.

All merges go branch → PR → squash with commitlint-clean messages and
English-only prose. CI runs the full matrix (`gh pr checks <n> --watch`);
do not merge before it is green.

## Dependency discipline

Adding a dependency is a liability. First ask whether the existing stack
covers it, check its size, maintenance, vulnerabilities (`pnpm audit`) and
license. Upgrades: one dependency per change, read the changelog not just
the version number, review the `pnpm-lock.yaml` diff, let the test suites
decide. Semver-major bumps for `typescript`, `zod` and `react-window` are
deliberately on hold.

## Dead code hygiene

After refactoring, list newly unused code and ask before deleting it. Let
`pnpm run knip` find orphans. Do not leave dead code around and do not
silently delete things you are unsure about.

## Honesty

No rubber-stamp "LGTM" without evidence. Do not soften real issues. Push
back on approaches with clear problems; accept the author's override
gracefully when they hold the full context.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "It works, that is good enough" | Unreadable or misplaced code compounds debt. |
| "The tests pass, so it is good" | Tests do not catch architecture or readability problems. |
| "We will clean it up later" | Later never comes; the review is the gate. |
| "It is just a version bump" | A bump is behavior you did not write. |

## Red Flags

- PRs merged without review or with "LGTM" only
- A refactor that moves complexity without removing it
- Feature logic creeping into a shared module
- A bulk dependency bump with no per-package isolation
- Review comments without severity labels

## Verification

- [ ] All Critical and Required findings resolved or explicitly deferred
- [ ] Tests pass and the build succeeds
- [ ] The change size is reviewable in one sitting
- [ ] The verification story is documented in the PR
