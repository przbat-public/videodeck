---
name: ci-cd-and-automation
description: Explains videodeck's CI checks, the shift-left local gate and the failure feedback loop for any change to build or pipeline config. Use when modifying CI workflows, Docker files or the verification scripts.
user-invocable: true
---

# CI/CD and Automation

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Shift left: everything CI checks runs locally first, so CI is the last
confirmation, not the first discovery. The pipeline in
`.github/workflows/ci.yml` mirrors the `AGENTS.md` gate one-liner, plus
the supply-chain and security jobs.

## The checks

| Check | What it proves |
| --- | --- |
| Format check | biome format has nothing to fix |
| Lint | biome check, hardcoded-Polish scan, tsconfig strictness pin |
| Typecheck | strict TS in server, client and extension (integration config included) |
| Unit tests (server) | jest, deep server integration included |
| Unit tests (client) | vitest, the full client unit suite |
| Unit tests (chrome-extension) | vitest |
| Client integration | real `<App />` against the real backend in-process |
| Server integration | fake yt-dlp + fake Elasticsearch |
| Coverage ratchet | coverage never falls below the committed floor |
| Playwright E2E | the thin mocked-API browser layer |
| Build | production bundles build |
| pnpm audit (moderate+) | dependency vulnerabilities |
| dependency-review, Analyze, CodeQL | supply chain and static security |

## The local gate

Run the full one-liner from `AGENTS.md` before pushing. Run it in order;
a red step is a stop (see `debugging-and-error-recovery`), not a queue for
later.

## Failure feedback

When CI fails, read the failing job log before re-running anything. The
job name says which layer broke. Fix locally with the matching command,
then push again. Do not "retry" a job to make it green; retries are for
infrastructure flakiness, and a flaky infra failure is itself a finding.

## Changing the pipeline

- A new check must have a local command equivalent; CI-only checks drift
  and surprise contributors.
- Keep the matrix names stable; branch protection and `gh pr checks`
  output reference them.
- Workflow changes are code: review them like code (`code-review-and-quality`),
  and watch `actions/` dependency bumps through Dependabot PRs.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "CI will catch it" | The local gate is minutes; a CI round trip plus review is hours. |
| "That job is flaky, retry it" | A flaky job is a test bug, not a button. |
| "This check is too strict" | The ratchet only moves when a decision moves it, not when a PR wants it moved. |

## Red Flags

- Skipping the local gate because "CI runs anyway"
- Retrying a red job without a code change
- Editing a workflow without running its local equivalent

## Verification

- [ ] The local one-liner is green before push
- [ ] Any workflow change has a local command equivalent documented
- [ ] CI failures were fixed in code, not retried away
