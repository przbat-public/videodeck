---
name: git-workflow-and-versioning
description: Applies videodeck's branch → PR → squash-merge discipline: atomic commits, commit-as-savepoint, change sizing and English-only history. Use for every code change in this repo.
user-invocable: true
---

# Git Workflow and Versioning

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

This repo is trunk-based with a protected `main`: every change is a
branch, a PR and a squash merge (ruleset-enforced). Commits are atomic
savepoints that each pass commitlint; the merge history stays clean
because the PR collapses into one commit.

## The flow

1. Branch from a fresh `main` (`git fetch origin && git checkout main &&
   git reset --hard origin/main` only when the tree is clean).
2. Commit small slices as savepoints: conventional format
   (`feat(queue): ...`, `fix(search): ...`), lowercase subject, English.
3. Keep the branch green: run the focused suites as you go, the full gate
   one-liner before pushing.
4. Open the PR with an English title and body (template at
   `.github/pull_request_template.md`), watch CI with
   `gh pr checks <n> --watch`, squash-merge, delete the branch.
5. Never `reset --hard` with uncommitted work in the tree; untracked files
   and edits are the only copy you have.

## Commit hygiene

- One logical change per commit; the body says why, not what.
- No "fix", "wip", "misc" subjects; the subject must read in `git log`.
- Never commit real `server/.env` values or the queue state file (both
  git-ignored; leave the user's data alone).
- Commit messages, PR text and docs are English-only (the repo rule).

## Change sizing

About 100 changed lines is ideal, 300 is fine for one logical change, 1000
means the PR should split (see `code-review-and-quality`). Squash merge
does not excuse an unreviewable branch: the diff is the diff.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I will tidy the history later" | The squash commit is the history. |
| "A giant PR is faster than three small ones" | Review and CI time per line disagrees. |
| "The commit message can say just 'update'" | Future you searches history to understand why. |

## Red Flags

- Pushing before the local gate ran
- Mixing a refactor and a feature in one PR
- `reset --hard` with uncommitted changes present
- Non-English commit or PR text

## Verification

- [ ] Commits pass commitlint locally (husky runs it anyway)
- [ ] The PR diff is reviewable in one sitting
- [ ] CI green before merge, branch deleted after
