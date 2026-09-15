---
name: security-and-hardening
description: Turns the videodeck security invariants into an audit workflow: threat model first, boundary validation, OWASP checks mapped to this app, dependency triage and secrets hygiene. Use when touching routes, config, yt-dlp arguments, outbound fetches, file paths or dependencies.
user-invocable: true
---

# Security and Hardening

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

Security work starts with the threat model, not with a checklist. This app
fetches remote content, runs a downloader with user-shaped arguments and
indexes attacker-influenced text; every change to those paths gets checked
against the invariants in `AGENTS.md`. The checklist at
`../../references/security-checklist.md` holds the pre-commit items.

## When to Use

- New or changed routes, middleware or config
- Anything near yt-dlp arguments, queue jobs or folder paths
- New outbound network calls
- Dependency additions or upgrades
- Anything that reads `server/.env` values

## Threat model first

Name what the change trusts and what can reach it:

1. **Network requests in.** The server binds loopback by default (`HOST`).
   The Host-header allowlist (`ALLOWED_HOSTS` in `server/src/env.ts`,
   applied in `server/src/app.ts`) blocks DNS rebinding; extra hosts are
   opt-in. A remote client also needs the API token when
   `REQUIRE_API_TOKEN` is on (`server/src/config.ts`).
2. **User-shaped URLs.** No user-controlled URL goes straight to `fetch`.
   Channel URLs are validated as YouTube channel URLs before yt-dlp sees
   them (`server/src/routes/folder.ts`). Internal and loopback targets
   stay blocked.
3. **User-shaped yt-dlp arguments.** `--cookies`, `--load-cookies` and
   `--cookies-from-browser` are rejected in
   `server/src/services/folderConfig.ts` (cookie-jar exfiltration). A new
   flag that reads local files or credentials needs the same treatment.
4. **Untrusted text in and out.** Video titles, descriptions, comments and
   transcripts are attacker-influenced data, parsed with zod
   (`shared/schemas.ts`) and rendered by React, which escapes output. Any
   new `dangerouslySetInnerHTML` needs a written reason.
5. **LLM output.** OpenAI responses are data, not instructions; parse them
   with zod before use. Video text that reaches the prompt is treated as
   prompt content, never as configuration.

## Boundary rules (no exceptions)

- **Always:** validate at the boundary with zod, never `as`-cast network
  data; keep secrets in `server/.env` only; keep the Host allowlist and
  the forbidden flag list intact.
- **Ask first:** widening `ALLOWED_HOSTS`, adding an outbound fetch target,
  any new dependency, any change to auth or CORS
  (`server/src/routes/http.ts`).
- **Never:** pass user-controlled URLs to `fetch` or a shell, commit real
  `server/.env` values, remove or weaken the forbidden yt-dlp flags, log
  secrets or API tokens.

## OWASP checks mapped to this app

- **Injection.** Command injection surface is yt-dlp arguments: the
  downloader runs with an argument list, never a shell string, and the
  forbidden flags are dropped before a job is enqueued. SQL injection does
  not apply (Elasticsearch queries are structured). Watch for path
  traversal on folder paths: they must resolve inside the configured
  videos root.
- **Broken authentication.** The API token comparison
  (`tokenMatches` in `server/src/routes/http.ts`) uses a constant-time
  check. New routes pick the auth middleware; do not hand-roll checks.
- **XSS.** React escaping plus the i18n catalogs cover the client. The
  Chrome extension inserts content into YouTube pages; keep its DOM writes
  limited to its own containers.
- **Broken access control.** Any route that writes files or enqueues jobs
  must validate the folder path against the allowed list
  (`requireAllowedFolder` in `server/src/routes/folder.ts`).
- **Security misconfiguration.** Defaults stay safe: loopback host, token
  optional only when self-hosting deliberately, CORS origins opt-in.
- **SSRF.** Covered by the threat model above; new outbound calls reuse
  the existing validation or add one, never `fetch(url)` raw.
- **Sensitive data exposure.** No tokens in logs; the request logger
  prints route, status and id, not bodies. Queue state and `.env` stay out
  of git (both git-ignored).

## Dependency triage

CI runs `pnpm audit` (moderate+), `dependency-review` and the OSV scanner.
A local finding goes: read the advisory, check whether the vulnerable path
is reachable, then patch, upgrade one package at a time (see
`code-review-and-quality` for upgrade discipline), or document the hold.
Review the `pnpm-lock.yaml` diff on every upgrade.

## Secrets management

- Values live only in `server/.env` (git-ignored); templates go in
  `server/.env.example`.
- Never copy a real token into a test, a fixture, a log or a PR body.
- If a real secret lands in git, treat it as compromised: rotate it, then
  scrub history. Do not just delete the file.

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "It is a local tool, no one can reach it" | LAN deployments and rebinding attacks reach it anyway. |
| "One extra fetch is fine" | Unvalidated outbound calls are how SSRF starts. |
| "The flag is harmless here" | The forbidden list is cheap to keep and costly to lose. |
| "I will rotate the token later" | A leaked secret is live until rotated. |

## Red Flags

- `fetch(userInput)` or shell string building with user input
- A weakened or bypassed forbidden flag check
- A real token or password in a diff
- A new route without auth or folder-path validation
- A dependency bump with an unreviewed lockfile diff

## Verification

- [ ] Threat model section completed for the change
- [ ] Boundaries validate input (zod, allowlists) at the entry point
- [ ] No secrets in the diff; `git status` shows no unexpected files
- [ ] `pnpm audit` clean or findings triaged
- [ ] Full gate one-liner green
