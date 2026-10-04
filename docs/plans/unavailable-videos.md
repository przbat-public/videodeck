# Unavailable videos: stop queueing what YouTube will not hand over

## Objective

The queue stops creating jobs for videos that cannot arrive (members-only,
Premium-only, or a video-level failure already observed), and the channel
console reports those videos as unavailable instead of counting them as missing
downloads. After this change, "download all" on the Charles Dowding channel
creates no failing job, and the row stops reporting 66 errors it can do nothing
about.

## Non-goals

- No cookies and no new yt-dlp flags. The allowlist in `folderConfig.ts` and the
  forbidden list stay untouched; downloading members-only content is out of
  scope by decision.
- No per-video reason in the folder state response. Row badges read
  `availability`, which the catalog already carries.
- No UI for the `force` escape hatch. It stays an API-level switch documented in
  `docs/API.md`.
- No change to the search index, the summary providers or the extension.
- No automatic cleanup of jobs already in the queue. Clear-finished stays a
  manual click.
- No change to the retry policy for transient failures.

## Decisions already made

- **Skip set from metadata is narrow:** only `subscriber_only` (members-only)
  and `premium_only` (YouTube Premium). `needs_auth` and `private` are rarer and
  their metadata is less reliable, so they keep the normal path and land in the
  failure record after one real attempt.
- **The failure record lives in the media folder** as `.unavailable.json`, next
  to `.videos-index.json` and `archive.txt`. It is per-folder state, and a drive
  swap or a server move keeps it.
- **TTL is 30 days**, reusing `UPDATE_STALE_AFTER_MS` from `shared/dates.ts`.
  After that the video gets one fresh attempt.
- **`force: true` bypasses both checks** for an operator who knows better.
- **Only video-level failure codes are remembered:** `members-only`, `private`,
  `removed`, `geo-restricted`, `age-gate`. `no-space` and `bot-wall` describe the
  machine or the session, not the video, so they are never recorded.

## Structure

- `server/src/services/unavailableVideos.ts` (new): the availability rule, the
  record read/write/prune, and the decision both enqueue checks share.
- `server/src/services/folderSummary.ts`: the count of unavailable videos.
- `server/src/services/downloadQueue/queue.ts`: record a permanent failure when
  a job finishes with a video-level code, clear the entry when a download of
  that video succeeds.
- `server/src/routes/folder/queue.ts`: the enqueue path consults the catalog and
  the record before it builds a request.
- `server/src/services/folderSummary.ts` and `server/src/routes/folder/summaries.ts`:
  feed the count.
- `client/src/utils/videoState.ts`: skip reason keys, availability labels.
- `client/src/components/`: the row badge and the channel counts.
- Unchanged: `ytdlp.ts`, `folderConfig.ts`, the extension, Elasticsearch, the
  folder state endpoint.

## Contract

`shared/schemas.ts`:

```ts
FolderSummarySchema = {
  videos: number; downloaded: number; notDownloaded: number; stale: number;
  unavailable: number;   // not on disk and known not to arrive
  newestUpdate?: string;
}
```

`notDownloaded` keeps its meaning (nothing on disk). The console shows
`notDownloaded - unavailable` as the number still to fetch, and `unavailable`
next to it with its own label. The field is additive, so an older client keeps
working.

`server/src/routes/validation.ts` (the enqueue body):

```ts
queueBodySchema = { folderPath, type, videos, force?: boolean }
```

Skip reasons travel in `SkippedVideoSchema.reason`, which is already a string.
The new values are the machine strings `members-only`, `premium-only`,
`private`, `removed`, `geo-restricted` and `age-gate`; the client maps them to
the existing `errors.job.*` copy.

i18n keys, pl and en in the same commit:

- `channelConsole.videos.unavailable_one/_few/_many` (`{{count}} niedostępny`,
  `{{count}} niedostępne`, `{{count}} niedostępnych`)
- `errors.job.premium-only` (the one reason without copy today)
- `videoState.badge.membersOnly`, `videoState.badge.premiumOnly`

## Style

Biome strict (no `any`, no non-null assertion, complexity 15), strict TS, no new
dependencies. Node's `fs/promises` and the existing `writeJsonAtomic` cover the
record. All prose in English, UI text through the catalogs.

## Testing

| acceptance criterion | test |
| --- | --- |
| a `subscriber_only` row is skipped, not queued | `server/src/services/unavailableVideos.test.ts`, `server/src/routes/folder.test.ts` |
| a `premium_only` row is skipped | same |
| a remembered code suppresses an enqueue until the TTL passes | `server/src/services/unavailableVideos.test.ts` |
| `force: true` queues anyway | `server/src/routes/folder.test.ts` |
| a permanent failure is recorded once, and a success clears it | `server/src/services/downloadQueue/queue.test.ts` |
| `unavailable` counts only videos not on disk | `server/src/services/folderSummary.test.ts` |
| the console shows missing and unavailable separately | `client/src/utils/channelTable.test.ts`, `client/src/components/ChannelTable.test.tsx` |
| the skip reason reaches the toast in Polish | `client/src/utils/videoState.test.ts` |
| pl and en stay in step | `client/src/i18n/locales.test.ts` |

The gate is `pnpm run verify`. During the loop: `cd server && pnpm run test -t
"<name>"` and `cd client && pnpm run test:run -t "<name>"`.

## Boundaries and risks

- **Security invariants:** no new yt-dlp flag, no user-shaped path, no new
  outbound fetch. The record file is server-written; ids are checked against the
  YouTube id shape and codes against a closed set before they are stored, so a
  hand-edited file cannot smuggle anything into a skip decision.
- **Read cost:** the enqueue path reads `list.json` once per request, the same
  read `GET /api/folder/list` already does. On the largest channel here that is
  a 500 row array.
- **Suppression risk:** a stale entry hides a download the user could have. The
  30 day TTL and `force` bound it, and a successful download clears the entry.
- **Write concurrency:** several jobs can finish at the same moment in one
  folder, so writes go through a per-folder chain rather than a read-modify-write
  race.
- **Count semantics:** `unavailable` is a new field; nothing reads it until the
  client change lands, and the server fills it in the same PR.

## Tasks

- [x] T1: add `server/src/services/unavailableVideos.ts` with the availability
  rule, the record shape and the TTL, unit tested
  acceptance: `cd server && pnpm run test -- -t "unavailableVideos"`
- [x] T2: `FolderSummarySchema.unavailable` plus the pure count in
  `folderSummary.ts` and its route wiring
  acceptance: `cd server && pnpm run test -- -t "summarizeFolder"`
- [x] T3: skip `subscriber_only` and `premium_only` at enqueue
  acceptance: `cd server && pnpm run test -- -t "enqueue skips"`
- [x] T4: record a video-level failure on finish, clear it on success
  acceptance: `cd server && pnpm run test -- -t "permanent failure record"`
- [x] T5: skip remembered videos until the TTL, honour `force`
  acceptance: `cd server && pnpm run test -- -t "remembered"`
- [x] T6: translate the skip reasons in the client and route the toast through
  `skipReasonText`
  acceptance: `cd client && pnpm run test:run -t "skip reason"`
- [x] T7: show unavailable videos separately in the console, with the row badge
  and the pl/en copy
  acceptance: `cd client && pnpm run test:run -t "unavailable"`
- [x] T8: document the behaviour in `docs/API.md`, `CHANGELOG.md` entry, add
  this plan to the humanizer gate list
  acceptance: `pnpm run humanizer:gate`
- [x] T9: full gate
  acceptance: `pnpm run verify`

## Outcome

Ten commits on `feat/unavailable-videos`, ending on a green `pnpm run verify`.
Two decisions changed while the work was built, and both are worth naming:

- `FolderSummary.unavailable` ships optional, not required. A required field
  rewrote about fifty summary fixtures in seven test files for one number that
  only the console reads, so an absent count reads as zero instead. The server
  fills it in on every answer.
- The refusal reasons reach the channel console through `skipReasonText`, which
  also fixed the one toast that printed the server's English code at the reader.

One commit sits outside this plan. `server/src/test-env.ts` now points
`QUEUE_STATE_FILE` at a temporary path, because a test run used to rewrite
`server/.queue-state.json`, the same file a dev server in this checkout reads.
That is how a live queue lost its pending jobs during this work, and the guard
has its own test so the two can never share a file again.
