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
  mock OpenAI server, fake yt-dlp writing real files, seeded temp folders)
  with no spawned processes and no Playwright at this layer; Playwright stays
  the thin mocked-API browser suite
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
- **Collection folders** for single downloads (the browser extension, yt-dlp
  in a terminal): `"kind": "collection"` in `config.json`, or the new box in
  the config form, turns a folder into a collection. Its console row says
  "kolekcja" instead of "brak channelUrl" and "brak list.json", its menu
  keeps the updates and drops the playlist and "Pobierz wszystkie", and
  opening the row lists the downloaded videos right away. That list comes
  from the folder index, which now records video titles and adds videos
  downloaded outside the queue each time the collection is read

- `sse_streams_open` on `/metrics`: how many download streams the server is holding open right now
### Added

- The client says when Elasticsearch is unreachable instead of turning it into
  a generic error per page: a banner under the top bar names what is off
  (search and indexing) and what still works (downloads, the video list, the
  queue), the search page reports the cluster rather than "no results", the
  index actions in the gear menu are disabled while it is down, and the retry
  clears the banner as soon as it answers again. A failed request reports the
  outage itself, so the banner does not wait for the next poll.

### Changed

- The search list remembers where you were reading. Opening a video and going
  back restores the pages that were on screen and the scroll position instead
  of dropping you at the top of a fresh first page

- The search results load the next page by themselves when you scroll near
  the end of the list, so "Pokaż więcej" no longer needs a click. The button
  stays under the list: after a failed page the automatic loading stops, and
  the button retries
- The runtime moved to **Node 24**: `.nvmrc`, the `engines` fields, the
  server image and the CI jobs all read the same pin, and `@types/node`
  follows it. Node 22 support ends in April 2027, so the move lands well
  before the date
- `extraArgs` in a folder's `config.json` is an allowlist now. A config may
  still throttle a channel, cap retries, skip Shorts and drop sidecars, and
  the editor hint lists exactly which flags those are. Everything else is
  refused with a message naming the argument, both by the API and when a
  hand-written `config.json` is read back

### Security

- **Closed a remote code execution path through `extraArgs`.** The old check
  was a list of forbidden flags, and yt-dlp's parser walks around such a list:
  `--alias` defines an arbitrary flag, short options cluster (`-ia` is two),
  any unambiguous prefix of a long option resolves, and a bare entry is
  another URL to download. Folder configs now accept only exact names from a
  fixed allowlist, with each value shape checked
- **Closed a second remote code execution path through `yt-dlp.conf`.** yt-dlp
  reads that file from its working directory, which for a download is the
  channel folder, so anyone who could write into that folder (a network share,
  a NAS, a synced drive) could hand it an `--exec`. Every yt-dlp call now
  passes `--ignore-config`, the playlist fetch included
- The server image builds in two stages and runs as the unprivileged `node`
  user, and the yt-dlp version it ships is pinned with a build argument
  instead of following the nightly channel. Check that the mounted video
  folders are writable by uid 1000 (see `docs/DEPLOYMENT.md`)
- The download queue state moved to `/app/state` in the image, mounted as the
  `queue-state` volume, so queued jobs outlive a container recreate
- Behind a proxy the rate limit can count the real client again: set
  `TRUST_PROXY` to the number of hops (the compose stack defaults to one) or
  leave it unset when the server is reached directly

### Security

- **Cross-site requests are refused on every path, token or not.** The Docker
  UI receives the API token from nginx, so a request carrying the token said
  nothing about who sent it: a page on another origin could reindex, drain the
  download queue or rewrite a folder config. A `Sec-Fetch-Site: cross-site`
  request is now answered 403 before the token is even read, nginx refuses it
  as well, and a `same-site` request (another port on this host) needs an
  origin from the trusted list instead of an open door
- **The download queue no longer trusts the URL in its own state file.** The
  queue rebuilds the video URL from the video id on restore, so a hand-edited
  `.queue-state.json` cannot point yt-dlp at `file://` or an internal address

- The extension declares Chrome 102 as its floor, which is what its use of `chrome.storage.session` requires
- Dependabot watches the workspace once instead of once per directory, so its pull requests match the single lockfile again; the GitHub Actions it runs are pinned to commit SHAs
- The client talks to the API through one helper instead of repeating the fetch, status check and schema parse in every hook, which is where a shared retry, de-duplication or timeout would go next
- The server build leaves `test-infra` out of `dist`, so a local build produces only what the server ships
### Fixed

- Loading the next page of results no longer re-announces "loading" to a
  screen reader for every page: the results region carries `aria-busy`, the
  page itself does not, and an incremental load is announced once, with how
  many videos arrived
- Error messages and the play overlay on a video card come from the
  translation catalogs now, so the Polish UI no longer shows English text
- Toast colors come from the design tokens (`--color-toast-bg`,
  `--color-toast-text`), which gives them a dark-mode variant and keeps
  `DESIGN.md` honest

- "Anuluj wszystko" works on a channel with thousands of queued jobs. It
  used to re-scan the whole queue and hold one more copy of the state file
  in memory for every job it cancelled, so 1,456 queued updates of one
  channel froze the server for minutes until it ran out of memory. The
  crash lost the cancellations too: the jobs came back on the next start.
  The whole channel now goes in a third of a second, with one write. A
  graceful stop (Ctrl+C, `docker compose restart`) no longer saves the jobs
  it kills as cancelled, so the next boot resumes them
- After a restart, "Anuluj wszystko" on one channel stays cancelled. Writing
  `.queue-state.json` made `tsx watch` kill the server before the rename
  finished, so the next boot restored the old queue and the button did
  nothing. The watcher now ignores that file, and the cancel response waits
  until the snapshot is on disk
- The header of a channel's video list keeps one shape: the counts and the
  queue summary ("kolejka: 3 w toku, 326 czeka") share a line, and the bulk
  buttons always start under them. The buttons used to slide next to the
  counts on a wide row while the queue summary sat on a line of its own.
  The list itself sits half a rhythm under the playlist actions, without the
  divider line and the three rhythms of air it used to open with.
- Updating a playlist or queueing videos from a channel's expanded section
  now updates the "Filmy" and "Kolejka" columns on the same page. Those
  actions used to refresh only the section itself; the console row above
  kept the numbers it had when the page opened
- The "Filmy" column of the download console follows the downloads. The
  counts were read once, when the page opened, and changed only after an
  action taken on that page; a download finishing in the background never
  moved them. The queue poll now spots a job leaving the queue and re-reads
  that folder alone (`GET /api/folder/summaries?folderPath=`), two disk reads
  instead of two per configured folder
- `GET /api/videos/channels` no longer answers 500 while a configured folder
  has no index yet. A freshly attached drive adds folders nobody has indexed,
  and the channel filter failed as a whole until every one of them was
  indexed; it now skips the missing aliases the way search already did
- An outage no longer makes every search wait out the client's retry budget:
  while an outage is fresh (5 s) reads are refused immediately, and
  `/metrics` publishes `elasticsearch_up` (1/0) for a dashboard
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

- The Chrome extension recognises Shorts, `youtu.be`, embed and live links. It matched only `watch` and `youtu.be` before, and its content script never ran on `youtu.be` at all
- Clearing the API token in the extension options removes the stored one instead of leaving the old value behind
- Search no longer breaks past the 10,000th result. Elasticsearch refuses a page that crosses its result window, and the server asked for one anyway, so scrolling deep into a large library ended in a 500. Pages are now shortened at the window edge, the client stops loading there, and the count stays honest
- A video-download stream that loses its client releases everything it held: the queue listeners, the keep-alive heartbeat and the open-stream gauge. The cleanup waited for the request to close, which happens when its body arrives, not when the browser goes away
- Starting an index rebuild while a recreation runs is refused, and the other way round, instead of interleaving alias promotions and leaving orphaned indices behind
- Two first-time index creations for one folder can no longer delete each other: the second caller joins the first instead of racing it
- The Playwright HTML report CI uploads is written again (the list reporter produced no report), and a second CI job runs the same suite against the production bundle, where build-only failures show up
- jsdom is pinned to the version the client suite passes on: 30.1.0 broke 27 tests in the Radix menus
- The API docs point at `POST /api/videos/refreshCache` (they said GET, which answers 404), and the stray ", " fragments left by an earlier edit are gone. The prose gate now also scans `docs/API.md`, `docs/INSTALL.md`, `docs/DEVELOPMENT.md` and `docs/README.pl.md`

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
