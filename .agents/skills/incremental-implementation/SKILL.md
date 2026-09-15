---
name: incremental-implementation
description: Builds videodeck changes as thin vertical slices: implement, test, verify, commit, then the next slice. Use for any change touching more than one file or package.
user-invocable: true
---

# Incremental Implementation

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Build in thin vertical slices. Each slice implements one observable piece
of behavior, carries its own tests, and leaves the repo green. The
alternative, a long horizontal pass that only works at the end, cannot be
reviewed, reverted or debugged in between.

## When to Use

- Any change touching more than one file
- Features that cross packages (schema in `shared/`, route in `server/`,
  UI in `client/`)
- Reworking an existing flow instead of adding to it

## The slice loop

1. **Pick the smallest observable behavior** from the plan
   (`planning-and-task-breakdown`).
2. **Write the failing test** for it (`test-driven-development`): the
   focused command from the stack table.
3. **Implement the minimum** to flip it green; when the slice crosses
   packages, wire them in dependency order (shared contract, server route,
   client hook and UI).
4. **Verify**: focused run, then the workspace suite.
5. **Commit** as a savepoint, English message, lowercase subject.
6. Repeat with the next slice.

## Safe defaults

- New behavior ships in its smallest useful form: a new route returns 501
  before it is wired, a new UI element renders behind an existing empty
  state, a new env seam has a safe default (see `YTDLP_PATH` and
  `QUEUE_STATE_FILE` for the pattern).
- Reverts stay cheap: a slice must never leave main in a state where
  reverting one commit breaks another.
- The repo ships without feature flags; the slice itself is the rollout
  unit.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I will wire it all up, then test once" | One giant green at the end hides which part broke. |
| "Committing half a feature is noise" | Commits are savepoints; noise is the un-reviewable blob. |
| "The default can wait" | Unsafe defaults ship by accident when the next slice stalls. |

## Red Flags

- Long stretches of code with no commit in between
- A slice whose test run does not pass before the next slice starts
- Defaults that flip existing behavior without an explicit decision

## Verification

- [ ] Each slice has its own failing-then-passing test
- [ ] The branch stays green at every commit
- [ ] Commit messages describe the slice, not the whole feature
