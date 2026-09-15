# Security Checklist (videodeck)

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

Pre-commit and pre-merge checks for any change. Pair with
`security-and-hardening` for the workflow behind these items.

## Before writing code

- [ ] The threat model is clear: what does the change trust, and what can
  reach it
- [ ] No new outbound network call without host or URL validation
- [ ] No new yt-dlp argument without checking the forbidden list
  (`server/src/services/folderConfig.ts`)

## Input and boundaries

- [ ] Network data parsed with zod (`shared/schemas.ts`), never `as`-cast
- [ ] Folder paths validated against the allowed list before any file or
  queue operation (`server/src/routes/folder.ts`)
- [ ] Channel URLs validated as YouTube URLs before yt-dlp runs
- [ ] LLM output parsed with zod before use

## Auth and headers

- [ ] New routes use the auth middleware when `REQUIRE_API_TOKEN` is on
- [ ] Token comparison stays constant-time
- [ ] CORS origins stay opt-in; no wildcard without a written reason
- [ ] The Host-header allowlist (`ALLOWED_HOSTS`) is unchanged unless the
  deployment needs it

## Data and files

- [ ] No real `server/.env` values in the diff, tests, fixtures or logs
- [ ] Queue state and env files stay git-ignored
- [ ] No user-controlled path concatenated into a filesystem or shell path
- [ ] React output stays escaped; `dangerouslySetInnerHTML` has a reason
  and sanitization

## Dependencies

- [ ] `pnpm audit` clean or every finding triaged (reachable? patched?
  held with a note?)
- [ ] Lockfile diff reviewed; one package per upgrade
- [ ] Major-version holds respected (typescript, zod, react-window)

## OWASP spot check

- [ ] Injection: argument lists, not shell strings; no SQL strings
- [ ] Broken access control: write paths and queue actions check ownership
  and folder allowlist
- [ ] Security misconfiguration: safe defaults kept (loopback host,
  opt-in remote auth)
- [ ] SSRF: internal and loopback targets blocked for outbound fetches
- [ ] Sensitive data exposure: no tokens, bodies or paths in logs

## Before merge

- [ ] `git status` clean of unexpected files
- [ ] Full gate one-liner green
- [ ] Security-sensitive changes reviewed against this checklist in the PR
