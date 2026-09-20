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
- **`pnpm run verify`**: one command chains the whole local gate (format,
  lint, type-aware ESLint, script linting and tests, knip, dependency
  cruiser, the humanizer gate, typecheck, unit, integration and Playwright
  suites), and CI installs through a shared composite action so the jobs
  cannot drift apart
- The checkbox and tooltip primitives come from Radix instead of hand-rolled
  markup, which brings the focus, keyboard and ARIA behaviour of both
  controls with them
- **Channel console on the download page**: `/download` now lists one row per
  channel with its playlist state, video counts and queue activity, filters
  and sorts that list, and expands a row into the folder section it replaced.
  Each row carries the queue actions that matter (download all, update stale,
  update all, cancel the channel's jobs, fetch the playlist) in one row menu,
  so a library of sixty channels stays near one screen instead of twenty
  stacked lists. The video column stacks its numbers as
  plain lines, the expanded row continues the table instead of opening a card
  of its own (no second header, no nested border), and the config form opens
  from the row menu. The counts come from a new
  `GET /api/folder/summaries` endpoint with its own cache, the table is
  reachable by URL (`q`, `filter`, `sort`, `folder`), and its header row
  sticks under the queue bar so the columns keep their names while the
  library scrolls past

### Fixed

- A stopped Elasticsearch no longer floods the terminal or blanks the
  download page: `/api/status` serves the folders from disk and reports
  `elasticsearch: "down"`, anything that reads documents answers
  `503 { error, code: "elasticsearch_unavailable" }`, and the server prints
  one compact line per 30 s instead of a stack per request (the boot log
  names the unreachable URL once, and `/health` keeps reporting the state)
- "Szukaj w tym kanale" on the download console opens the list page filtered
  to that channel. The link used to carry the folder path, which the search
  filter (`channelName`) never matches, so it landed on an empty result. The
  channel of every folder now comes with `GET /api/videos/channels`, and a
  folder whose videos are not indexed has no search entry at all
- The page landmark no longer draws the blue focus ring after a route
  change. The app moves focus there on purpose so screen readers announce
  the new page, but the landmark is not a tab stop, so the ring only ever
  read as a stray border along the top of the page on first load
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
- The select dropdowns no longer leak the keyboard focus ring into mouse
  hover (Radix focuses the hovered option, and the portal clipped the
  outline into stray top/bottom segments); keyboard navigation keeps a
  visible ring, and native form controls like the date picker now follow
  the dark theme
- A global top bar now leads the app: the film list is the home route, the
  download page moved to /download, and a gear menu holds navigation, the
  index actions (list page only), the theme and the language. The old
  toolbar and its video counter are gone
- The download queue no longer marks a job done when it was cancelled while
  the post-job hook was still running, no longer brings a cancelled job back
  after a restart, and no longer starts a retry while the queue is paused. A
  batch whose videos failed to index is retried instead of counted as indexed
- A failed search says why it failed instead of showing "nothing matched", a
  failed "show more" keeps the pages already loaded, and the results area
  marks itself busy while a new search runs
- Restricted yt-dlp flags can no longer be smuggled into a folder config
  through the prefix spellings yt-dlp accepts (`--prox`, `--print-to-fi`) or
  the short forms (`-p`, `-u`, `-a`, `-o/path`): the argument builder now
  refuses them before anything is spawned
- Queue rows measure their own height, so an error log no longer paints over
  the row below it, and a long row title clamps to two lines like the search
  result titles already did
- The folder list header wraps its bulk buttons on a phone instead of running
  off a 360px screen, and the search highlight got its background back
- Failed status and detail loads offer a retry, every page renders inside a
  `<main>` landmark, and a route change that drops focus moves it to the new
  page instead of leaving it on the document body
- The queue controls on the status page poll while the page is open, so
  "clear finished" tracks jobs finished elsewhere, they report a failed
  request instead of silently staying disabled, and their error text is
  translated rather than English
- The weekly dependency report runs `pnpm outdated` and `pnpm audit`; it used
  to run the npm commands in a pnpm workspace, fail, and print "0 vulns" for
  a check that never ran. A command that cannot answer now says so
- Server request logs keep the request path and drop the query string, so
  folder paths and search phrases no longer end up in the log file
- The paging integration journey waits for the appended page instead of
  failing on a loaded machine
- The Docker stack builds again: `context: ..` pointed one directory above
  the checkout, `.dockerignore` hid the `chrome-extension` manifest the
  Dockerfiles copy, and neither image carried `tsconfig.base.json`, which both
  package configs extend. `docker compose build` now produces both images. The
  web UI container also receives the API token and adds it to the requests it
  proxies, so the shipped `REQUIRE_API_TOKEN=true` default no longer answers
  the UI with 401
- The server refuses to start when `HOST` is not a loopback address and
  neither `API_TOKEN` nor `REQUIRE_API_TOKEN=true` is set, instead of
  serving an open API to the network by accident
- The queue controls no longer report a load failure while the queue is
  healthy: Express answered the browser's conditional polls of `/api` with
  `304 Not Modified` and no body, which `fetch` reports as a failed response.
  API responses no longer carry ETags and are sent with
  `Cache-Control: no-store`; files keep their own caching headers
- Request logs carry the full path again. Reading it after Express had
  rewritten the URL inside the mounted router logged `/api/videos/search`
  as `/search`


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
