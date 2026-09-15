---
name: deprecation-and-migration
description: Treats videodeck code as a liability: planned deprecation, migration patterns and zombie code removal for old APIs, config keys and dependency major bumps. Use when removing systems or sunsetting behavior.
user-invocable: true
---

# Deprecation and Migration

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Code is a liability until it is deleted. Every API field, config key and
behavior someone might rely on needs a deliberate end: announced,
migrated, then removed. Zombie code, the stuff nothing calls but nobody
removes, is the same liability without the announcement.

## When to Use

- Removing or renaming an API field or a queue state shape
- Changing an env var or config key in `server/.env`
- Bumping a held major version (typescript, zod, react-window)
- Cleaning up dead client reducers, unused exports or orphaned helpers

## Compulsory vs advisory

- **Compulsory** (breaks operators or consumers): a renamed env var, a
  removed route, an ES mapping change, an SSE contract change. These get a
  CHANGELOG entry, an upgrade note in the release (see
  `shipping-and-launch`), and a grace window where the old shape still
  parses and warns.
- **Advisory** (repo-internal): unused exports, dead reducers, stale
  helpers. Delete them directly after `pnpm run knip` and grep confirm
  nothing references them; list the removals in the PR.

## Migration patterns

- **Parse both, warn on the old.** Read the new key, fall back to the old
  one, log a one-line warning, drop the old key after the next release.
- **Schema-first.** API shape changes start in `shared/schemas.ts`; the
  server and client migrate against the zod types, then the old field is
  removed in a follow-up PR.
- **Data formats.** Queue state and ES mappings change only with a
  migration or an explicit "reindex required" note; never silently.

## Known holds

Dependabot ignores semver-major bumps for `typescript`, `zod` and
`react-window` because each needs an API migration first. Lifting a hold
is its own PR: the migration, the test suite updates, and the dependabot
config change in one reviewable unit.

## Zombie code removal

1. Find it: `pnpm run knip`, plus a grep for the suspected name.
2. List it in the PR, ask before deleting anything surprising.
3. Delete it with the tests that prove the callers still pass.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "Keep it for compatibility, it costs nothing" | It costs every future reader and every agent. |
| "We can remove it in a later PR" | The later PR is this one, just after the breakage. |
| "A major bump can wait forever" | Holds that outlive their owner become frozen tech debt. |

## Red Flags

- A removed route or renamed env var with no CHANGELOG entry
- Silent data-format changes in queue state or ES mappings
- Dead code kept "just in case" without a caller
- Bulk major bumps that skip the migration step

## Verification

- [ ] Old and new shapes coexist with a warning during the grace window
- [ ] CHANGELOG and release notes cover every compulsory change
- [ ] `pnpm run knip` is clean after a removal pass
- [ ] The dependabot hold config matches the hold list above
