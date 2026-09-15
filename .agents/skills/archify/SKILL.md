---
name: archify
description: Turns the committed videodeck architecture JSON in docs/architecture/ into validated, interactive HTML diagrams with the vendored zero-dependency CLI, and compares architecture snapshots for PR review. Use when asked to map the system, update an architecture diagram, or review a change that moves package boundaries.
user-invocable: true
---

# Archify (videodeck)

> Adapted from [tt-a1i/archify](https://github.com/tt-a1i/archify) (MIT), vendored from commit `d673e8300df60a5c8166abe78787fdc78f6b8000`, rewritten for videodeck conventions. The vendored CLI makes no network requests; `ARCHIFY_UPDATE_CHECK_DISABLED=1` is set by the repo scripts.

## Overview

The repo keeps its architecture diagrams as typed JSON in
`docs/architecture/`. The vendored CLI validates each file and renders it
to a committed, self-contained HTML artifact. Editing a diagram means
editing the JSON, then re-running `deliver`; the committed HTML is
regenerated and the golden check in `pnpm run test:scripts` fails if the
two ever drift apart.

## Commands

Run from the repo root, always with the update check disabled:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node .agents/skills/archify/bin/archify.mjs validate architecture docs/architecture/videodeck.architecture.json --quality showcase --json
ARCHIFY_UPDATE_CHECK_DISABLED=1 node .agents/skills/archify/bin/archify.mjs deliver architecture docs/architecture/videodeck.architecture.json docs/architecture/videodeck.architecture.html --quality showcase --json
```

`pnpm run test:scripts` runs both for every diagram plus the golden
render check.

## Authoring loop

1. Edit the JSON. Keep at most 12 primary nodes, one clear main path,
   sparse labels, short side branches.
2. Validate after every edit; a showcase pass reports all 9 artifact
   checks with 0 errors and 0 warnings.
3. Deliver the HTML, then `git add` the regenerated artifact with the
   JSON in the same commit.
4. Follow the diagnostics: each one names the exact subject, evidence and
   supported fixes. Keep automatic routing unless a diagnostic asks for a
   routing control, and apply at most one geometry fix per repair.

## Diagram conventions

- Nodes and labels state facts from the code: route names, status values
  and event types must match `shared/`, `server/src/` and
  `chrome-extension/src/`.
- English labels, no em dashes, humanizer-clean prose in titles and
  cards.
- A change that moves package boundaries or adds a service updates the
  architecture JSON in the same PR (see `code-review-and-quality` for the
  delta step).
- The five diagram types live in `schemas/`; read one matching example in
  `examples/` for field shape, never for facts.

## Delta review

Before merging a PR that changes boundaries, compare snapshots:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node .agents/skills/archify/bin/archify.mjs compare architecture <base.json> <head.json> /tmp/delta.html --json
```

The receipt lists added, removed, changed, moved and rerouted facts;
paste its summary into the PR description next to the regenerated
diagram.

## Verification

- [ ] Every diagram validates with all 9 showcase checks
- [ ] The committed HTML was regenerated from the edited JSON
- [ ] `pnpm run test:scripts` is green (validation plus golden render)
- [ ] Node and edge facts were checked against the code
