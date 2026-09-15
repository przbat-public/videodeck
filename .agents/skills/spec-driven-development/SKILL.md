---
name: spec-driven-development
description: Writes a short PRD (objectives, commands, structure, style, testing, boundaries) in docs/plans/ before code for any videodeck feature larger than a single-file fix. Use when starting a new feature or a significant change.
user-invocable: true
---

# Spec-Driven Development

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Spec before code. For anything bigger than a single-file fix, write a short
PRD in `docs/plans/<slug>.md` first, get it approved by the human, then
plan and build from it. The spec is the shared memory of what "done" means;
without it, reviews argue about intent instead of implementation.

## When to Use

- A new feature touching more than one workspace package
- A change to the API contract in `shared/schemas.ts`
- A migration or a rework of an existing flow (search, queue, summaries)

Skip it for small fixes and doc changes; `test-driven-development` covers
those directly.

## The PRD template

Write it in `docs/plans/<slug>.md`, English, humanizer-clean, under 2 pages:

1. **Objective.** One sentence: what the user can do after this lands that
   they cannot do today.
2. **Non-goals.** What is deliberately out of scope.
3. **Commands.** The dev and test commands this work uses (copy them from
   `AGENTS.md`, the full gate one-liner included).
4. **Structure.** Which workspaces change: `server/`, `client/`,
   `chrome-extension/`, `shared/`, `test-infra/`. State what stays put.
5. **Contract.** API changes first, in zod (`shared/schemas.ts`). i18n keys
   for new UI text, pl and en in the same change. Queue or SSE changes
   spelled out, since both have consumers on the other side.
6. **Style.** Biome strictness, strict TS, no new deps without a reason,
   architecture boundaries from `dependency-cruiser`.
7. **Testing.** Which of the four layers covers the change and one named
   test per acceptance criterion (RED → GREEN).
8. **Boundaries and risks.** What the change must not do (security
   invariants, no cross-app imports), and what could break.

## Process

1. Write the PRD. Ask clarifying questions first if the ask is
   underspecified (`interview-me`).
2. Present the PRD for approval; do not start coding on a draft.
3. Break it into tasks with `planning-and-task-breakdown`.
4. Build task by task with `incremental-implementation` and
   `test-driven-development`; update the PRD only when the approved scope
   genuinely changes, and say so in the PR.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "The code is the spec" | Reviews need the intent to check the code against. |
| "It is a small feature" | Small features still cross i18n, schemas and tests. |
| "We can write the spec later" | Specs written after code document what was built, not what was wanted. |

## Red Flags

- Coding starts before the PRD is approved
- The PRD has no non-goals or no named tests
- API and i18n changes missing from the contract section

## Verification

- [ ] `docs/plans/<slug>.md` exists and the human approved it
- [ ] Every acceptance criterion has a named test
- [ ] The PR links the plan file
