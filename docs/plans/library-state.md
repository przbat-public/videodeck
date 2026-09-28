# Live library state: drives appear without a reload

## Objective

The library is a set of channel folders on removable drives, but the app reads
it as if it were fixed at boot. After this lands, plugging a drive while the app
is open adds its channels to the download console and to the search filter in
about a second, and unplugging one marks those channels unavailable instead of
leaving them looking empty. Nobody reloads a tab. The console names the new
channels that have no index yet and offers one action to index them.

Measured on the current build, server started with
`VIDEOS_FOLDER_PATH='/tmp/hotplug/*/*'`: a channel folder created after boot
appears in `GET /api/status` only once the 10 s folder cache expires, and the
request that trips the cache still answers with the old list. An open page
never shows it, because `useStatus` reads `/api/status` once at mount
(`client/src/hooks/useStatus.ts`) and the 10 s `/api/health` poll carries no
library data.

## Non-goals

- No udev, `diskutil` or other per-OS volume APIs. The server watches the
  configured roots, the host owns its volumes.
- No change to the search contract, to index naming or to the queue protocol.
- No file-level watching inside channel folders. The library is the set of
  channel folders, not the videos inside them.
- No live updates in the Chrome extension. It reads the library when opened,
  and the download stream it consumes keeps its shape.
- No automatic indexing of a drive that just appeared. Detection leads to a
  notification and one action; the disk stays idle until somebody asks.
- No new dependencies. `fs.watch` plus a reconciliation pass covers this.
- No removal of the manual controls. "Odśwież indeks" and the folder config
  editor work the way they do today.

## Decisions already made

- The folder list becomes owned, versioned server state. A new
  `server/src/services/libraryState.ts` holds the parsed roots, the glob
  expansion, the current folder set, a monotonic `revision` and a listener
  list. `getVideosFolderPaths()` in `config.ts` reads that snapshot, so the
  nineteen call sites keep their synchronous call and lose the 10 s TTL with its
  one-request lag. `config.ts` keeps env parsing and the error for an empty
  `VIDEOS_FOLDER_PATH`.
- Watching is self-arming. The watcher attaches to the longest existing
  ancestor of each root, which is `/Volumes` while a drive is away, and it
  re-attaches when that ancestor appears or disappears. Each event is debounced
  by 300 ms and followed by a real glob reconcile: an event says "something
  moved", never "these folders exist now".
- A backstop reconcile runs every 60 s. Network shares and Docker file sharing
  do not always deliver inotify events, and a missed event must cost a minute,
  not a restart.
- One SSE channel carries the changes: `GET /api/events`, assembled from the
  parts the download stream already uses (`registerSseStream`, 15 s heartbeat
  comments, a zod check before the wire, cleanup on close, shutdown ends
  streams). nginx already turns buffering off for `/api/`
  (`client/nginx.conf.template`), so the compose stack needs no proxy change.
- The stream carries identity and notification, never page data. The first
  frame on connect holds the current revision, folders and unavailable paths;
  later frames carry the new revision and what changed. Pages read
  `/api/status` and their other data themselves, so a late or reconnecting
  client resyncs from the first frame.
- The web client reads the stream with `fetch` and a body reader, not
  `EventSource`. In the compose stack the client container holds the API token
  and adds it as a header, and `EventSource` cannot send headers. The frame
  parser moves from `chrome-extension/src/lib/sse.ts` to `shared/sse.ts` and
  takes the zod schema as an argument, so both consumers share one parser.
- Client state lives in one small store beside `elasticsearchStatus.ts`, read
  through `useSyncExternalStore`. `useStatus`, `useChannelNames`,
  `useCategories`, `useFolderSummaries` and `useChannelQueue` re-read when the
  revision changes. No page component changes: pages keep deciding what to
  render, not when to read.
- When the stream cannot be established, the shell falls back to polling
  `/api/health`, whose answer gains the same revision. That is the degraded
  path, not the design.
- Server caches stop guessing with timeouts. `/api/status` stays cached per
  revision (it already keys on the folder list) and the category cache is
  dropped on a library change, so ten open clients on one revision cost one
  rebuild.
- Unplugged folders stay in the snapshot as unavailable and `/api/status`
  reports them, so the row says "dysk odłączony" instead of showing an empty
  channel or a count from before the drive left.
- Detection and notification, never a scan on its own. When the folder set
  grows, the server announces the new folders, the console marks the rows
  without an index (the chip it already renders) and offers the existing
  `onlyMissing` reindex as one action. A drive that arrives while nobody is
  looking costs nothing until somebody asks, and no volume starts disk I/O by
  being plugged in.

## Commands

```bash
pnpm run dev                 # server :3001 + client :3000
pnpm run test                # server, client and extension unit suites
cd server && pnpm run test   # focused: libraryState, events, folder routes
cd client && pnpm run test:run
pnpm run test:integration    # real <App /> against the in-process backend
cd client && pnpm run test:e2e
pnpm run test:scripts        # the prose-gate coverage check lives here
pnpm run humanizer:gate
pnpm run verify              # the full gate, unchanged
```

## Structure

`server/`

- new `services/libraryState.ts`: watch, debounce, reconcile, revision,
  listeners, metrics.
- new `routes/events.ts`: `GET /api/events`, mounted in `app.ts` beside the
  other routers, auth and no-store inherited.
- `config.ts`: env parsing stays, glob expansion and the cache move out.
- `index.ts`: start the watcher after `validateVideosFolder`, stop it on
  shutdown.
- `utils/videoPathUtils.ts`: validate the snapshot, keep the fail-fast error
  for a literal path that is not there.
- `routes/folder/config.ts`: `unavailableFolders` in the status body, cache
  keyed by revision.
- `services/folderConfig.ts`: drop the category cache on a library change.
- `metricsRegistry.ts`: `library_revision`, `library_folders`,
  `library_changes_total`, `library_watch_errors_total`.

`shared/`

- new `sse.ts`: the frame parser, parameterised by schema.
- `schemas.ts`: `libraryEventSchema`, `HealthResponseSchema.revision`,
  `StatusResponseSchema.unavailableFolders`.

`client/`

- new `utils/libraryStatus.ts` (store), `utils/libraryStream.ts` (stream,
  reconnect, fallback poll), `hooks/useLibraryRevision.ts`.
- the five data hooks above, `hooks/useServerHealth.ts` (`/api/health` stays
  the poll for the fallback), `components/AppLayout.tsx` (opens the stream
  once), `i18n/locales/{pl,en}.json`.

`chrome-extension/`

- `src/lib/sse.ts` re-exports the shared parser; its behaviour and tests stay.

`test-infra/`

- a helper that adds and removes a channel folder in the seeded temp library
  while the app is running, and one that reads an SSE stream to the first
  matching event.

What stays put: search internals, index naming and versions, the queue and its
state file, the summaries endpoints, the extension's download flow.

## Contract

- New `GET /api/events` (SSE, under the same auth as every `/api` route).
  First frame: `{ type: 'library', revision, folders, unavailable }`. Later
  frames add `added` and `removed`. The union has one member today, and a new
  member is additive: a client ignores a type it does not know. A frame that
  fails `libraryEventSchema` is dropped with a warning, the way the download
  stream drops one.
- `HealthResponseSchema` gains `revision: number` (additive; the extension's
  parse strips what it does not know).
- `StatusResponseSchema` gains `unavailableFolders: string[]`, empty when every
  configured folder is mounted. `videosFolderPath` keeps its type and meaning,
  so no client breaks mid-deploy.
- New i18n keys, pl and en in the same change: `library.driveMissing` (row
  chip), `library.detected` (toast, takes the channel count),
  `library.reindexNew` (the one-click action for folders without an index).

## Style

- One store plus one subscription hook, no new context and no prop drilling.
  The chip reuses the existing status chip, the toast reuses `react-hot-toast`,
  and the announcement uses `role="status"` so a screen reader hears that a
  drive arrived.
- Tokens and primitives only, per `DESIGN.md`; dark mode comes with them.
- Biome strictness, strict TS, no `any`, no new deps. The new server module is
  a service, so `lint:deps` gains no edge it does not already allow.
- This file joins the `humanizer:gate` list with its baseline score.

## Testing

One named test per acceptance criterion, RED first.

1. A drive plugged in while a page is open adds its channels without a reload:
   `client/src/__tests__/integration/library.journey.integration.test.tsx`,
   "a channel folder added under a watched root appears in the console".
2. An unplugged drive marks its channels unavailable:
   `server/src/routes/folder.test.ts`, "reports an unplugged folder as
   unavailable", plus the second case in the journey above.
3. A missed watcher event is caught by the backstop:
   `server/src/services/libraryState.test.ts`, "a silent watcher still
   reconciles inside the backstop window".
4. A client that connects late sees the current library at once:
   `server/src/routes/events.test.ts`, "the first frame carries the current
   revision and folders".
5. A blocked stream degrades to the revision poll:
   `client/src/utils/libraryStream.test.ts`, "falls back to polling
   `/api/health` when the stream never opens".
6. A folder that just appeared can be indexed with one click, and nothing
   scans by itself: the client journey "the console offers a reindex for the
   folders that just appeared", plus the existing server case in
   `server/src/routes/videos.test.ts`, "passes onlyMissing=1 so cached folders
   are skipped".
7. A change costs one reconcile and one status rebuild, whatever the number of
   open clients: `libraryState.test.ts`, "a burst of events triggers one
   reconcile", and `folder.test.ts`, "two status reads at the same revision
   share one body".

The integration layer carries the weight here, which is what it is for: the
real `<App />` against the real backend over a seeded temp library, with a
folder appearing underneath it mid-test. The watcher itself takes an injectable
clock and an injectable watch factory, so no unit test sleeps or depends on
inotify.

## Outcome

- PR1 `feat(server): own the video library as watched state`: the service, the
  wiring in `config.ts` and `index.ts`, metrics, the `config.test.ts` move.
- PR2 `feat(server): stream library changes over SSE`: the route, the shared
  schema, the `/api/health` revision, shutdown and rate-limit checks.
- PR3 `feat(client): follow library changes without a reload`: the store, the
  stream with its fallback, the five hooks, `AppLayout`, tests.
- PR4 `feat(client): show a missing drive on its channel row`: the
  `unavailableFolders` field, the chip, the detection toast, pl and en copy.
- PR5 `feat(client): reindex the folders that just appeared`: the detection
  toast with its action, wired to the existing `onlyMissing` reindex, and the
  count of new channels on it.

Each PR links this file and ships on its own.

## Boundaries and risks

- `fs.watch` is advisory. Events are dropped by design under load and missing
  entirely on some network shares, so the reconcile decides and the backstop
  covers the gap. The boot log names the watched ancestor and the strategy, and
  `library_watch_errors_total` makes a dead watcher visible.
- A large copy into a channel folder produces a storm of events. The debounce
  collapses it, and a reconcile only lists the ancestors of the configured
  roots, so it does not read a `config.json` per folder.
- Docker: a bind mount of one drive path cannot see a volume that was mounted
  after the container started, and no watcher helps there. The deployment doc
  keeps the rule: mount the volume parent, then `/volumes/*/*` works and the
  container sees mounts and unmounts.
- nginx cuts an idle SSE connection after an hour. Reconnect is expected
  behaviour, not an error, and the first frame after a reconnect carries the
  current revision, so a client cannot miss a change silently.
- A drive that just appeared stays unindexed until somebody acts, so search
  misses its videos by design. The row chip and the toast say so. That is the
  trade the operator picked over disk I/O starting at plug time.
- The stream must not become a second source of truth for folders. It carries
  what to re-read, and every field it sends is derived from the same snapshot
  `/api/status` uses.
- Boot validation keeps failing fast on a literal path that does not exist.
  Detection covers globs and drives that come back, it does not turn a typo in
  `VIDEOS_FOLDER_PATH` into a silent empty library.
