---
name: shipping-and-launch
description: Release and rollback checklists for the self-hosted videodeck stack (RELEASING.md, docker-compose.yml, docs/DEPLOYMENT.md). Use when preparing a release, tagging or planning a rollback.
user-invocable: true
---

# Shipping and Launch

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

A videodeck release is a git tag plus a GitHub Release, documented in
`CHANGELOG.md`. There is no rollout infrastructure: operators pull the new
image themselves, so the release notes carry the upgrade path and the
rollback path.

## Pre-launch checklist

1. Full gate one-liner green on `main`; CI green on `main`.
2. Bump the version in all four `package.json` files (root, `server/`,
   `client/`, `chrome-extension/`), in lockstep.
3. Move `## [Unreleased]` in `CHANGELOG.md` to a dated release entry.
4. Tag and release:
   `git tag vX.Y.Z && git push origin vX.Y.Z`, then
   `gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md)"`.
5. Upgrade notes for operators: say whether the ES mapping or the SSE
   contract changed. Both require action on their side (reindex, a
   coordinated extension update).

`RELEASING.md` is the source of truth; keep this checklist aligned with it.

## The deployment surface

`docker-compose.yml` + `docs/DEPLOYMENT.md` define the stack. A change
that touches env vars, volumes or ports needs a `docs/DEPLOYMENT.md`
update in the same PR; a silent drift between the compose file and the
docs breaks operator upgrades.

## Rollback

- Operators roll back by redeploying the previous image tag; the queue
  state file (`server/.queue-state.json`) and the ES indices must survive
  a version hop. Do not ship a change that rewrites those formats without
  a migration story or an explicit "reindex required" note.
- A bad release gets a revert PR on `main` and a new patch tag; do not
  edit or move an existing tag.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I will write the release notes after" | The tag is public the moment it pushes; notes after is confusion. |
| "Nobody reads the upgrade notes" | The one operator who reindexes at 2am does. |
| "A hotfix can skip the checklist" | Hotfixes are releases too, just smaller. |

## Red Flags

- Version bump in fewer than six package.json files
- A release with no CHANGELOG entry
- An SSE or ES mapping change without upgrade notes
- Tags edited or moved after push

## Verification

- [ ] All six package.json versions match
- [ ] CHANGELOG has the dated entry
- [ ] Upgrade notes cover ES mapping and SSE contract changes
- [ ] `gh release` published from a green main
