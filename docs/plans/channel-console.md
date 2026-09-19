# Channel console on the download page

## Objective

After this lands, `/download` opens as a console for channels instead of a
stack of full channel sections. One row per channel shows its state, how many
videos are missing, what the queue is doing with it and the actions that
matter, and the page stays about one screen tall whether the library holds
5 channels or 60. The per-channel video list, the config editor and the
playlist section stay reachable by expanding a row.

Measured with 20 channels on the current page: 8 516 px (10.6 screens) before
the lists load, 18 317 px (22.9 screens) after, 22 582 px (28.2 screens) at
360 px, with 20 nested 400 px scroll areas inside the page scroll and no way
to jump to a channel.

## Non-goals

- No change to the search page. It already filters by channel, and the console
  links into it.
- No queue API redesign, no new job fields, no change to the SSE stream.
- No per-channel pause or drag-and-drop ordering of channels.
- No config editing changes: `FolderConfigEditor` is reused as it is.
- No table virtualization. A few hundred rows are fine; revisit past that.
- No changes to `chrome-extension/` or to `test-infra/` beyond test needs.

## Decisions already made

- The table is the default `/download` view. `FolderSection` (config, playlist,
  video list) survives unchanged as the expanded row, so nothing is lost.
- Browsing a channel's videos stays one click away through a "Szukaj w tym
  kanale" link to `/?channel=<folder>`.
- Per-channel counts come from a new `GET /api/folder/summaries` with its own
  cache. They are not added to `GET /api/status`: that response already reads
  every `config.json` and every `list.json` and takes up to 3 s with 56
  folders on external disks, and the page being redesigned must not get slower.
- The table renders as soon as `/api/status` answers. Count columns show a dash
  until the summaries arrive, and a channel whose summary failed keeps its row
  with the other columns intact.
- Queue state per channel comes from one unfiltered `GET /api/folder/queue`
  call grouped by `folderPath`, not from one request per channel.
- The 30-day "not updated" rule moves into `shared/` so the client and the new
  endpoint cannot drift apart.
- URL state carries `q` (text filter), `filter`, `sort` and `folder` (expanded
  row). Deep links, reload and Back all work, following the model of
  `client/src/utils/searchUrlState.ts`.
- The table has five columns: channel, playlist, videos, queue and actions. It
  carries no category column and no Elasticsearch index column, which the
  maintainer asked to drop: the category stays visible in the config editor and
  reachable through the text filter, and a missing index becomes one chip next
  to the channel name, where it keeps feeding the "needs attention" filter
  without spending a column on a state that settles once per channel.

## Structure

- `shared/`: `FolderSummarySchema` and `FolderSummariesResponseSchema` in
  `schemas.ts`, plus the stale-days constant and its helper next to the
  existing date helpers. The client's `isOlderThanMonth` keeps working and
  delegates to the shared rule.
- `server/`: the summaries handler in `routes/folder.ts`, reading each folder's
  `list.json` and index in parallel through `utils/runPool.ts`, with a 5 s
  cache keyed by the expanded folder list. No Elasticsearch call on this path.
- `client/`: `components/ChannelTable.tsx` (table, header row, row menu) and
  `components/ChannelRow.tsx`, `hooks/useFolderSummaries.ts`,
  `hooks/useChannelConsoleState.ts` (URL state), `utils/channelTable.ts` (pure
  filter, sort and "needs attention" selectors). `StatusPage.tsx` composes the
  sticky queue bar and the table; `FolderSection` moves into the expanded row.
  `App.css` gets the table, card and sticky-bar styles. `index.css` unchanged.
- `docs/`: a table block in DESIGN.md section 6 and a line in section 11 about
  the mobile card collapse.

## Contract

- New zod shapes in `shared/schemas.ts`:
  `FolderSummarySchema { videos, notDownloaded, downloaded, stale, newestUpdate? }`
  and `FolderSummariesResponseSchema { summaries: Record<string, FolderSummary> }`.
  `StatusResponseSchema` and `QueueJobSchema` are unchanged.
- New endpoint `GET /api/folder/summaries`, no parameters, answering for every
  configured folder. A folder that cannot be read reports zeroed counts rather
  than failing the whole response.
- i18n keys in `pl.json` and `en.json` in the same change: column headers,
  filter chips, sort labels, row actions, the needs-attention reasons, the
  empty state and the summaries error.
- No queue or SSE change: the queue column reuses the existing polling hook.

## Style

- Tokens only, both themes, no new dependencies. The Radix `Menu` primitive
  already in the repo holds the secondary row actions.
- Real `<table>` semantics: `<caption>` or `aria-label`, `<th scope="col">`,
  `aria-sort` on the sortable headers, one sticky header row.
- Touch targets reach 44 px; at the 360 px breakpoint the table collapses into
  one card per channel with labelled values, no horizontal scrolling.
- Biome strictness, strict TS and the dependency-cruiser boundaries stay as
  they are.

## Testing

- Server (`routes/folder.test.ts`, `schemas.test.ts`): counts for a seeded
  folder (downloaded, missing, not updated, newest update date); a folder whose
  `list.json` is unreadable reports zeroes instead of a 500; the second request
  inside the cache window does not re-read the disk; a response shape check
  against the zod schema.
- Client unit: `utils/channelTable.test.ts` for filtering, sorting and the
  needs-attention grouping; `hooks/useFolderSummaries.test.ts` for load, error
  and retry; `components/ChannelTable.test.tsx` for one row per folder, expand
  and collapse, the row actions calling the existing queue hooks, `aria-sort`
  on the sortable columns and the filter chips emptying the table. A named test
  pins the five columns and asserts that no category or index column comes
  back.
- Integration, real backend in process: `/download` renders a row per seeded
  folder, expanding a row loads that channel's list, and the "Szukaj w tym
  kanale" link lands on the list page with `?channel=`.
- E2E: a new `e2e/channel-console.spec.ts` with 20 mocked channels asserts the
  document stays within about two viewports, the queue column shows running and
  failed counts, filtering narrows the rows, and the page scrolls to a channel
  without any nested scroll area. The responsive spec gains the console at
  360 px: cards, no horizontal overflow, 44 px targets.
- Existing specs that assert the old section layout are updated in the same
  change and named in the PR.

## Boundaries and risks

- Only configured folders are summarised, resolved through the same allowlist
  the other folder routes use. No file names, no absolute paths beyond the
  folder paths the client already receives.
- Summaries read from external disks. That is why they have their own cache,
  their own loading state and no place in the critical path of the page.
- Twenty rows with four bulk buttons each would be 80 buttons. The row keeps
  one primary action and moves the rest into the row menu, which keeps the
  table scannable and the keyboard order short.
- Dropping the category column means the console cannot group or filter by
  category on its own. The text filter still matches it, the search page has
  the category filter, and the config editor shows it; a category chip can be
  added next to the channel name if the table turns out to need one.
- Removing the stacked sections is a visible change: the responsive and
  accessibility probes run at all three breakpoints before merge, and the
  screenshots in `docs/screenshots/` are refreshed.
- If a user has hundreds of channels, the table becomes long again. Sort,
  filter and the needs-attention chips are the answer before virtualization
  is, and virtualization stays a separate change.
