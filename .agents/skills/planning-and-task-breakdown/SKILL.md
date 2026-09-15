---
name: planning-and-task-breakdown
description: Decomposes an approved videodeck spec into small, verifiable tasks with acceptance criteria and dependency ordering, each at most one commit. Use after a PRD exists and before implementation starts.
user-invocable: true
---

# Planning and Task Breakdown

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Turn an approved spec (`spec-driven-development`) into a task list where
every task is small, independently verifiable and mapped to the repo's
Definition of done. A good task is reviewable in one sitting and leaves
the repo green when finished.

## When to Use

- After a PRD is approved and before coding
- When a change would otherwise land as one giant PR
- When an existing plan stalls because its steps are too big to verify

## Task rules

1. **One concern.** A task changes one thing: a schema field, a route, a
   component, a catalog entry. Not "the feature".
2. **One commit.** A task ships as at most one commit on the branch.
3. **Verifiable.** Each task carries an acceptance criterion that is a
   command or a test name, not a wish:
   `pnpm run test:scripts`, `cd client && pnpm run test:run -- -t "search
   submits on Enter"`.
4. **Ordered.** Dependencies first: shared contract before the server,
   server before the client integration, UI copy with the component.
5. **Green at every step.** The focused suite passes after each task; the
   full gate runs before the PR.

## Task template

```markdown
- [ ] T1: add `planId` to the queue item schema (shared/schemas.ts)
  acceptance: `cd server && pnpm run test -- -t "queue item schema"`
- [ ] T2: ...
```

## Mapping to the Definition of done

Every task must say where it satisfies the standing bar:

- behavior: named test written first (`test-driven-development`)
- UI text: i18n keys, pl + en in the same change
- API: `shared/schemas.ts` updated with the zod shape
- user-visible: `CHANGELOG.md` entry with the feature PR

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I will split it later" | The split is the plan; later is a giant PR. |
| "This task is too small" | Small tasks are the point: cheap to review, easy to revert. |
| "Acceptance is obvious" | If it cannot be a command, it cannot be checked. |

## Red Flags

- A task that touches server, client and schemas at once without a reason
- Acceptance criteria that are prose instead of commands or test names
- A plan whose tasks cannot be committed independently

## Verification

- [ ] Every task has a command-shaped acceptance criterion
- [ ] Order respects package dependencies
- [ ] Each task maps to the Definition of done items it needs
