---
name: using-agent-skills
description: Routes incoming videodeck work to the right skill from the repo catalog and restates the shared operating rules. Use at the start of a session or when unsure which skill applies.
user-invocable: true
---

# Using Agent Skills

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

This repo ships a skill catalog under `.agents/skills/`. Each skill is a
workflow with steps, checkpoints and verification gates. This meta-skill
routes incoming work to the right one and states the rules every skill
shares.

## Routing table

| Incoming work | Skill |
| --- | --- |
| Vague request, unclear scope | `interview-me`, then `spec-driven-development` |
| New feature or big change | `spec-driven-development` → `planning-and-task-breakdown` → `incremental-implementation` |
| Any logic, bug fix, behavior change | `test-driven-development` |
| Something broke | `debugging-and-error-recovery` |
| Reviewing or merging | `code-review-and-quality` |
| Routes, config, yt-dlp args, dependencies | `security-and-hardening` |
| UI, CSS, user-visible text | `ui-design` (and `DESIGN.md`) |
| Docs, PR text, prose | `humanizer` |
| Commits, branches, PRs | `git-workflow-and-versioning` |
| CI or build config | `ci-cd-and-automation` |
| Releases and rollbacks | `shipping-and-launch` |
| Removing or renaming things | `deprecation-and-migration` |
| Not sure which applies | this skill |

## Shared operating rules

Every skill in this repo obeys the same standing rules from `AGENTS.md`:

- English-only commits, PRs, docs and comments; Polish only through the
  i18n catalogs.
- The full gate one-liner runs green before a PR (format, lint, lint:types,
  lint:scripts, test:scripts, knip, lint:deps, humanizer:gate, typecheck,
  test, test:integration, e2e).
- branch → PR → squash merge; main is protected.
- The Definition of done: test written first, i18n parity, schemas
  updated, changelog entry, gate green.

## Composing skills

Skills chain, they do not stack blindly. A feature starts with spec and
plan, builds with slices and TDD, ships through review. If a skill's exit
criteria conflict with the repo rules, the repo rules win; report the
conflict instead of silently bending one side.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I know the repo, no skill needed" | Skills encode the repo's own gates; skipping them skips the gates. |
| "Apply all skills at once" | Chaining matters; blind stacking produces noise. |
| "The skill is for other agents" | It is for anyone changing this code, you included. |

## Red Flags

- Work started without routing it to a skill
- A skill's verification steps skipped "to save time"
- Two skills disagreeing and the conflict silently papered over

## Verification

- [ ] The right skill was chosen and its steps followed
- [ ] Every skill invoked ran its verification section
- [ ] The repo's standing rules held (language, gate, workflow)
