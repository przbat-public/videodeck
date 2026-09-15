# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **pnpm workspaces** (like vita-tracker): one `pnpm-lock.yaml`, corepack-pinned
  pnpm, a `@videodeck/shared` workspace package and a new **`test-infra`**
  package shared by the server and client test suites
- **Client integration suite** in the vita-tracker style: the real `<App />`
  renders against the REAL backend booted in-process (fake Elasticsearch,
  mock OpenAI server, fake yt-dlp writing real files, seeded temp folders) ,
  no spawned processes, no Playwright for this layer; Playwright remains the
  thin mocked-API browser suite
- Download queue persists active jobs across server restarts (jobs resume as
  queued after reboot; paused state is kept) and graceful shutdown now waits
  for yt-dlp children to stop and closes open SSE streams before exiting
- Index rebuild ("Odbuduj indeksy") now tracks the background job to
  completion with a progress toast instead of reporting done immediately;
  a rebuild that is already running is joined, and failures surface the
  server-side error
- **Design contract and landing page**: `DESIGN.md` codifies the visual
  language (tokens, typography, spacing, components, a11y), a repo-scoped
  `ui-design` skill turns it into a checklist for UI changes, and a static
  landing page built from the same tokens lives at `docs/landing/index.html`
- **Engineering skill pack, part one**: repo-scoped skills for test-driven
  development, code review, debugging and security hardening, shared testing
  and security checklists in `.agents/references/`, and a repo-invariant
  script that validates skill frontmatter and the no-em-dash rule
- **Engineering skill pack, part two**: skills for spec-driven development,
  task breakdown, incremental slices, requirement interviews, and the
  git/CI/shipping/deprecation workflow adapted to the branch, PR and
  squash-merge flow and our CI checks
- **Engineering skill pack, part three**: the ui-design skill gains
  component-architecture and WCAG 2.1 AA guidance with an accessibility
  checklist, a using-agent-skills routing skill, and four review personas in
  `.agents/personas/`
- **Architecture map with archify**: the vendored archify CLI (MIT) renders
  the runtime architecture from typed JSON in `docs/architecture/`, and
  `pnpm run test:scripts` validates every diagram and goldens the committed
  HTML so the map cannot drift from its source
- **Archify diagrams, part two**: queue lifecycle, SSE download stream and
  CI/release workflow maps join `docs/architecture/`, and the review persona
  plus the PR template now ask for an architecture delta receipt when
  package boundaries change
- **Context linter**: `scripts/check-context.test.mjs` (part of
  `pnpm run test:scripts`) pins every command and path AGENTS.md references
  to the real repo, keeps the Skills list aligned with the skill
  directories, and fails on stale npm or npx commands in our docs
- **AGENTS.md craft pass**: the four working principles (understand,
  minimize, prove, verify) join the Definition of done, and the Skills
  section states the progressive-disclosure rule
- **UI audit scorecard**: the ui-design skill's audit mode now scores five
  dimensions (tokens, hierarchy, primitives, a11y, copy) with Nielsen
  heuristics, design laws and a persona walkthrough, every finding tagged
  by business impact

### Fixed

- Stale npm commands in the docs (README, the Polish README, CONTRIBUTING,
  RELEASING, the PR template and the chrome-extension guides) now say pnpm,
  and the release gate one-liner matches the one in AGENTS.md again
- `GET /api/videos/recreateIndices/status` reports the real state of the
  index rebuild; per-folder failures no longer abort the remaining folders
- Removed dead client reducer code (unused `RESET` actions, `video` state
  field) and switched the remaining hand-cast API responses to zod parsing
- Accessibility and UX polish: primary color darkened to WCAG AA contrast,
  the search input gained an accessible label and a "minimum length" hint,
  the detail player shows the downloaded thumbnail as its poster, the
  document language follows the UI language, and the extension's content
  script observes only the watch-page subtree instead of the whole body
- Enter commits the search phrase immediately instead of waiting out the
  debounce
- Dark theme: a system/light/dark picker (persisted, follows the OS until a
  choice is made) re-tunes the design tokens; all hardcoded surface/text
  colors moved onto the token layer
- CI now enforces the coverage ratchet (server + client) and runs the
  server integration suites on every PR: yt-dlp argument templates against
  an offline fake binary and the Elasticsearch suite against a real
  single-node cluster. Nothing is skipped on CI
- The search bar channel filter is now the same select control as sort and
  category, with an "All channels" option that clears the filter, and the
  theme picker no longer carries its leftover width cap


## [1.0.0] - 2026-09-14

First public release.

### Added

- Full-text search over downloaded videos (titles, descriptions, comments,
  transcripts) backed by Elasticsearch, with highlighting, sorting and
  category/channel/date filters
- Server-side yt-dlp download queue with pause/resume, per-folder concurrency
  limits, retries with backoff, and fast-fail for permanent errors
  (members-only, private, removed videos)
- Per-channel `config.json`: resolution cap (h264/aac preference), subtitle
  languages, comments, extra yt-dlp args, browser impersonation, concurrent
  fragments and SponsorBlock removal
- In-browser player with multi-language subtitle tracks and AI (OpenAI)
  video summaries with disk caching and cost metrics
- Status page with per-folder configuration editor, playlist
  (`list.json`) management and bulk actions with confirmation
- Chrome MV3 extension: enqueue videos straight from YouTube with live SSE
  progress
- Polish/English UI (react-i18next) with typed keys and locale parity tests
- Security hardening: Host-header allowlist (DNS rebinding), SSRF-guarded
  video URLs, restricted yt-dlp flags, Helmet, rate limiting, env validation
- Prometheus metrics (`/metrics`), `/health` and `/health/live` probes

[Unreleased]: https://github.com/przbat-public/videodeck/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/przbat-public/videodeck/releases/tag/v1.0.0
