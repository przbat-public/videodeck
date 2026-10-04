# Library control: per-video state, gap repair and an app-owned archive

## Objective

The video list stops being a yes/no flag. Each video reports what is actually
on disk (video, thumbnail, which subtitle languages, description, comments),
which videos the channel no longer lists, and which downloads left something
behind. The app decides what to fetch instead of leaving that to yt-dlp's
`archive.txt`, and `archive.txt` becomes a file the app can verify and repair.

## Non-goals

- No changes to the search index (Elasticsearch) or to the summary pipeline.
- No new yt-dlp flags outside the existing allowlist in `folderConfig.ts`.
- Comment pacing stays out of scope. The repair action reuses whatever
  `writeComments` the folder config sets.
- No bulk scheduling UI. The queue keeps taking an explicit video list.

## Commands

`pnpm run verify` is the gate. During the loop: `cd server && pnpm run test -t
"<name>"`, `cd client && pnpm run test:run -t "<name>"`, then the full suite of
each workspace, `pnpm run test:integration` and `cd client && pnpm run
test:e2e` before the gate.

## Structure

- `shared/schemas.ts` (and `shared/api.ts` types): the new contract below.
- `server/src/services/folderIndex.ts`: the index grows per-file presence and
  moves to `version: 2`; a v1 index is rebuilt on read.
- `server/src/services/videoState.ts` (new): one place that turns an index
  entry, a `list.json` row and the archive into the per-video state.
- `server/src/services/archive.ts` (new): read, diff, reconcile and append.
- `server/src/services/ytdlp.ts`: `buildYtDlpArgs` gains the `repair` job type.
- `server/src/routes/folder/state.ts` (new): the state and archive endpoints.
- `server/src/services/downloadQueue/`: the `repair` type and the post-job
  artifact check.
- `server/src/routes/folder/playlist.ts`: `list.json` gets the trimmed shape.
- `client/src/components/`: the badges, the detail panel and the two actions.
- `test-infra` and `scripts/fake-bin/yt-dlp`: the fakes follow the new flags.

## Contract

New zod schemas in `shared/schemas.ts`:

```ts
VideoFilesStateSchema = {
  video: boolean; thumbnail: boolean; description: boolean;
  subLangs: string[]; comments: boolean; infoBytes: number;
}
VideoArchiveStateSchema = { onDisk: boolean; inArchive: boolean; drift: boolean }
DownloadStateSchema = {
  files: VideoFilesStateSchema | null;   // null when nothing is on disk
  archive: VideoArchiveStateSchema;
  missing: ('thumbnail' | 'description' | 'comments' | string)[]; // 'pl' is a subtitle language
}
```

`ChannelVideoSchema` gains `duration?: number`, `viewCount?: number`,
`uploadDate?: string`, `availability?: string`, `downloadState?:
DownloadStateSchema`, and `orphan?: boolean` (on disk, absent from
`list.json`). Every field is optional so an older `list.json` still parses.

Routes:

| Route | Meaning |
| --- | --- |
| `GET /api/folder/video-state?folderPath=&videoId=` | one video's state |
| `GET /api/folder/state?folderPath=&filter=all\|incomplete\|orphan\|not-downloaded` | the whole folder's state, orphans included |
| `POST /api/folder/archive/reconcile` | `{ folderPath, method: 'add' \| 'remove' \| 'rebuild', videoIds?: [] }` |
| `POST /api/folder/repair` | `{ folderPath, method: 'sidecars' \| 'comments', videos: [{ videoId }] }` |

`JobType` gains `repair`. A repair job runs `--skip-download` with the sidecar
flags and passes no `--download-archive`, so it always does the work it was
asked for. The console's existing bulk actions keep sending explicit video
lists, which is the app-side decision B3 asks for.

## Queue and archive behaviour

- `repair` jobs are metadata work: `--skip-download`, `--write-subs`,
  `--write-auto-subs` with the configured languages, `--write-info-json`,
  `--write-description`, `--write-thumbnail`, and `--write-comments` only for
  `method: 'comments'`.
- After any download or repair job the queue checks the artifacts it promised.
  A job whose `.mp4`/`.mkv` never appeared ends as `done` with
  `incomplete: true` and a log line naming what is missing, because `yt-dlp -i`
  otherwise reports success for a download that produced nothing.
- `archive.txt` stays the shared record with plain yt-dlp runs. The app only
  reconciles it, and refuses to when the folder shows no `info.json` at all:
  an unmounted drive must not empty the archive.

## Style

Biome strict, strict TS, no new dependencies, no cross-app imports. UI text
through i18n keys with pl and en in the same change.

## Testing

| Layer | Test |
| --- | --- |
| server unit | `folderIndex.test.ts`: presence fields survive a round trip; a v1 file is rebuilt |
| server unit | `videoState.test.ts`: missing list per language, orphan flag, drift flag |
| server unit | `archive.test.ts`: diff, add, remove, rebuild, unmounted-drive refusal |
| server unit | `ytdlp.test.ts`: repair args carry the sidecar flags and no archive |
| server unit | `videoScanner.test.ts`: comment and thumbnail detection |
| server integration | `deepServer.integration.test.ts`: repair a video through the fake yt-dlp and see the state change |
| client unit | `VideoItem`/`FolderSection`: badges render from state, filters select the right rows |
| client integration | real `<App />`: repair a channel's gaps against the real backend |
| e2e | the mocked console shows the badges and runs the repair action |

## Boundaries and risks

- The security invariants hold: `videoId` is validated, folder paths go through
  `requireAllowedFolder`, and no new yt-dlp flag enters the allowlist.
- `archive.txt` is destructive to edit. Every write goes through the
  unmounted-drive guard and a temp file.
- The index version bump forces one full rebuild per folder on first read after
  the upgrade. For a channel with thousands of videos that is one scan of many
  `info.json` heads, and it should stay under a minute per folder.
- A download the user started in a terminal is already in `archive.txt`. After
  this change the app no longer needs the archive to avoid re-downloading it,
  because the index marks those files as downloaded.
