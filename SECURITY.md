# Security Policy

## Supported versions

Only the latest release (and the `main` branch) receive security fixes. This
is a self-hosted application — please keep your installation up to date.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report them privately to **[przemek@batte.pl](mailto:przemek@batte.pl)** with:

- affected version(s),
- a description of the issue and its impact,
- steps to reproduce (or a proof of concept, if available).

You will receive an acknowledgement within 72 hours and a status update within
7 days. We ask that you give us up to 90 days before disclosing the issue
publicly, and we will credit you in the release notes (unless you prefer to
stay anonymous).

If you prefer GitHub's flow, use the repository's **Security → Advisories →
Report a vulnerability** (private vulnerability reporting).

## Scope

In scope: the application code in this repository (server, client, shared,
Chrome extension).

Out of scope:

- Vulnerabilities in third-party software the app orchestrates (yt-dlp,
  ffmpeg, Elasticsearch, Node.js) — report those upstream.
- A misconfigured personal deployment (e.g. the server bound to a public
  interface with `HOST=0.0.0.0` and no `API_TOKEN`) — see the README's
  "Security" section.
- Issues requiring physical access to the machine.

## Disclosure policy

- Fixes land on `main` first and are backported to the latest release.
- Advisories are published together with the release, after a 90-day window
  or once the reporter agrees to earlier disclosure.
