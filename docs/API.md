# API and file format reference

The HTTP endpoints, the Elasticsearch indexing model behind search, the
on-disk yt-dlp file layout and the per-channel `config.json` options.

## API Endpoints

### Browser requests

The guard in front of `/api` and `/metrics` judges a browser request before it reads the token. A request marked `Sec-Fetch-Site: cross-site` gets a 403. One marked `same-site` needs a trusted origin: the dev client on `localhost` or `127.0.0.1` (ports 3000, 4173 and 5173), an entry in `CORS_ORIGINS` or a Chrome extension, limited to the ids in `EXTENSION_ORIGINS` when that is set. Browsers send the marker only to HTTPS and loopback addresses, so on a LAN address such as `http://nas.local:3000` a request without it is judged by its `Origin`. A request with no `Origin` passes (curl, a link, an image), `null` is refused, and any other value must be a trusted origin, the address the request was sent to (behind nginx, the `X-Forwarded-Host` it sets, which counts only when its name is loopback or in `ALLOWED_HOSTS`, else `Host`) or a host in `ALLOWED_HOSTS`.

### GET /health (public)

Readiness probe: pings Elasticsearch and returns `200 { status: 'ok', elasticsearch: 'ok' }`, and when ES does not respond: `503 { status: 'degraded', elasticsearch: 'down' }`. The Chrome extension uses it in its "Test connection" (pl: „Test połączenia") button. A cluster that answers but refuses writes still gets a `200`, with `writes: 'refused'` added. That means a block at the write level on the cluster or on a `videos_*` index, such as the `index.blocks.read_only_allow_delete` the flood-stage disk watermark puts on the indices of a full node: search keeps working, new videos do not reach it, and the UI shows a read-only banner. The blocks come from `GET /_cluster/state/blocks`, which needs `cluster:monitor/state`. The ping needs `cluster:monitor/main`, and the `monitor` cluster privilege grants both: a user without it gets the `503` above, as if the cluster were down. Only a role that grants the ping without `cluster:monitor/state` gets past the ping and still never sees the `writes` field. A healthy answer is cached for 5 s, so frequent polling does not burden ES, while one that is down or refuses writes is checked again on every probe.

### GET /health/live (public)

Dependency-free liveness probe: `200 { status: 'ok' }` when the server process responds. The server image's `HEALTHCHECK` asks it every 30 s, so a `200` here counts in `http_requests_total` but leaves no line in the request log.

### GET /metrics

Prometheus: `http_requests_total` and `http_request_duration_seconds` (method/route/status labels on the counter, method/route on the histogram; unknown paths go to the `unmatched` label so as not to multiply series per URL), `download_queue_size`, and summary cost metrics: `summary_requests_total`, `summary_tokens_total`, `summary_estimated_cost_cents_total`, each labelled with the provider (`openai` or `deepseek`) and the model that was asked, by its configured name and not the dated snapshot a response names (`gpt-4o`, not `gpt-4o-2024-08-06`). The cost is a USD estimate based on that model's approximate pricing; DeepSeek is priced at its off-peak rate. An answer that holds no summary counts as an `error`, and its tokens are still recorded.

The endpoint sits behind the same guard as `/api`: with `API_TOKEN` set, a scrape has to send `Authorization: Bearer <token>`.

### GET /api/events

Server-Sent Events stream of library changes. The frame a connection opens with describes the library of that moment: `revision`, the channel `folders` and the paths that are configured or remembered but `unavailable`, which is how a page says "drive unplugged" instead of dropping the channel. Every later frame repeats those fields and adds `added` and `removed` against the frame sent before it.

A client that connects late, or reconnects after a dropped connection, resyncs from its first frame, so it never has to poll the folder list. Frames are `data: <json>` blocks, and both sides parse them with the same schema (`libraryEventSchema` in `shared/schemas.ts`). An idle stream carries a `: ping` comment every 15 s; the client image's nginx closes a connection after an hour, so a reconnect is expected rather than an error.

The stream is notification only. It says which folders the library holds and what moved; the page re-reads `/api/status` and the rest of its data, and `revision` in `GET /health` and `GET /api/health` carries the same number for a client that cannot hold the stream open.

### POST /api/videos/refreshCache

Refreshes and reindexes all videos from the configured folders into Elasticsearch.

The method is POST, not GET, because starting a reindex changes server state.
A link or an image on another site sends a GET without an `Origin`, and to a
LAN address over plain HTTP without `Sec-Fetch-Site` too, so the guard cannot
tell it from curl. Every POST a browser sends carries an `Origin` (see
Browser requests).

**Response:**

```json
{
  "message": "Cache refresh process started",
  "status": "ok"
}
```

**Cache on removable drives.** Each folder's index lives in Elasticsearch under an alias computed from the folder path and **survives unplugging the drive**. After swapping drives, search immediately uses the aliases of the currently attached folders (the previous drive is simply not searched), and the status page shows only the missing index per folder (`indeks ES: brak`, "ES index: missing"). Instead of a full reindex, it is then enough to call:

```
POST /api/videos/refreshCache?onlyMissing=1
```

The server then reindexes only folders without an existing index (e.g. a drive attached for the first time). Folders with a cache are skipped and keep serving search. In the web UI this is the **"only missing (use existing index)"** checkbox (pl: „tylko brakujące (użyj istniejącego indeksu)") next to the "Refresh index" button (pl: „Odśwież indeks"). A full reindex (without the parameter) remains for situations where the drive contents changed and the existing index must be rebuilt.

**Note:** This endpoint starts the indexing process in the background and returns immediately. If a reindex is already running, it returns `409` with the current status. Progress can be followed via `GET /api/videos/refreshCache/status` (the client does this itself and shows it in a toast).

### GET /api/videos/refreshCache/status

State of the ongoing (or last) reindex.

```json
{
  "running": true,
  "startedAt": "2026-09-11T12:37:47.681Z",
  "currentFolder": "/Volumes/MEDIA/example-channel-2",
  "foldersDone": 4,
  "foldersTotal": 56,
  "filesDone": 1018,
  "filesTotal": 2563,
  "indexed": 3285,
  "skipped": 8,
  "rejected": 0,
  "errors": [],
  "folderErrors": 0
}
```

`filesDone/filesTotal` refer to the current folder, the counts to the whole run: `indexed` documents written, `skipped` videos whose files could not be read, and `rejected` documents Elasticsearch refused one at a time while the rest of their batch was written. A batch it refuses whole fails its folder instead. `errors` lists the first 20 failure messages, a folder's or the whole run's. `folderErrors` counts every folder that failed, those past the 20 messages included. `lastError` is the last error message, and `finishedAt` appears once finished. A video needs its video file (`.mp4` or `.mkv`) and its `info.json`; one without a thumbnail is indexed all the same. When a folder holds videos and not one of them could be read, as on a drive failing its reads, the folder keeps the index it had and shows up in `errors`.

#### How the reindex works

Every folder has an **alias** `videos_<sha256(folderPath)[:16]>` in Elasticsearch, pointing at exactly one physical index `videos_<hash>_<timestamp>`. The reindex:

1. creates a new, empty physical index,
2. reads `info.json` from disk and writes documents in batches (`_bulk`): at most 50 documents or ~16 MB per request, because channels with tens of thousands of comments have `info.json` files of 50 MB and Elasticsearch rejects requests above 100 MB,
3. once the whole folder is written, atomically switches the alias to the new index (`_aliases`) and deletes the previous one.

Thanks to this, search works the whole time on the old index version, and an interrupted reindex (error, server restart) does not leave an empty index. At most an orphaned `videos_<hash>_<timestamp>` index remains, which is removed at the next successful reindex of that folder. Videos with the same `videoId` (duplicates on disk) go into a single document.

Comments are **not** stored in ES as objects. Only one text field, `commentsText`, which search runs over. It keeps whole comments, from the first one `info.json` lists, up to 10,000,000 characters: a video with a few hundred thousand comments made a document larger than the 100 MB a request may carry, so its later comments are left out of search. The `GET /api/videos/:id/details` endpoint reads the full comment tree from `info.json`. The `commentsText` field is not returned in search results. An `info.json` larger than the longest string Node can hold (536,870,888 characters, about 512 MiB) cannot be read whole, so such a video is indexed from the head of the file: search finds it by its title, without description, counts or comments, and its details open with no comments.

After every download-queue job (`download`/`update`), the changed videos are indexed incrementally, so a new video is visible in search without a full reindex. A job that finishes while its own folder is being reindexed hands its videos to that reindex instead: they become searchable once the new version is swapped in. If the server stops before that swap, the next full reindex brings them in.

**Changing the analysis requires a full reindex:** an index keeps the
mapping, the analyzer chain and the documents it was built with, and both an
`onlyMissing` run and a drive swap leave it in place. Every new index records
the analysis version it was built under in its mapping
(`_meta.analysis_version`, 1 at present), and at boot the server logs a
warning for each folder whose index carries an older one, naming what a
rebuild brings. After an upgrade that raises it, call
`POST /api/videos/refreshCache` without `onlyMissing`: new indexes get the
current analysis, and the aliases switch atomically.

### GET /api/videos/search

Searches videos by phrase in the title (`title^3`), description (`^2`), subtitle transcript (`transcriptText^2`), and comments (`commentsText`). The file name is not searched: a video without a title takes one from its file name at indexing time. Text is analyzed with **diacritic folding** (custom `polish_folded` analyzer: `standard` + `lowercase` + `asciifolding` + `english_possessive`), so `srodek` finds `środek` without typing Polish characters, and `world` finds "World's" because the trailing `'s` is stripped on both sides. Polish stemming/stop words would require the `analysis-stempel` plugin (absent from the default Docker image), so the analyzer uses only built-in components. Transcripts and comments are search-only fields; they are never returned in responses. Match snippets are cut from the first 100,000 characters of a field, so a phrase found deeper into a long comment section still returns its video, only without a snippet.

**Query parameters:**

- `q` (optional) - search phrase. A YouTube link (watch, `youtu.be`, Shorts) or a bare 11-character video id is looked up by id under the same filters, sort and paging: a link returns that video or nothing, and a bare id that matches no archived video is searched as text
- `sort` (optional) - sort order; when it is missing or unknown, a phrase ranks by relevance and an empty `q` lists the newest first:
  - `relevance` - by `_score`, the default with a phrase. Every folder is an index of its own, so scores come from the term statistics of all searched folders together (`dfs_query_then_fetch`) rather than per folder
  - `date-desc` - by date, newest first, the default without a phrase
  - `date-asc` - by date, oldest first
  - `views-desc` - by view count, descending
  - `views-asc` - by view count, ascending
  - `likes-desc` - by like count, descending
  - `likes-asc` - by like count, ascending
- `category` (optional) - narrows the search to channels with this category (case-insensitive comparison). `totalCount` then applies to the category alone. A category that exists in no `config.json` returns zero results - never everything.
- `offset` (optional, default 0) - first result to return (pagination)
- `limit` (optional, default 100, max. 500) - results per page

The client appends further pages with the "Show more" button while `videos.length < totalCount`.

**Response:**

```json
{
  "videos": [
    {
      "baseName": "video_name",
      "title": "Video title",
      "description": "Description...",
      "videoPath": "video_name.mp4",
      "thumbnailPath": "video_name.webp",
      "folderPath": "/path/to/folder",
      "uploadDate": "20231201",
      "viewCount": 1000,
      "likeCount": 50,
      "channelName": "Channel name",
      "comments": []
    }
  ]
}
```

`thumbnailPath` is left out for a video with no thumbnail on disk, here and in the details, and the client draws a placeholder in its place. The thumbnail is the plain `<stem>.webp`, `.jpg`, `.jpeg` or `.png`, or else the highest numbered variant `--write-all-thumbnails` wrote; the folder console counts thumbnails by the same rule.

### GET /api/videos/categories

Categories declared in the `config.json` files of the configured folders - sorted, without duplicates (variants differing only in case are merged). Feeds the picker in search.

```json
{ "categories": ["fpv", "lego", "psychology"] }
```

The category **does not go into Elasticsearch**. Every folder has its own index alias, so the filter simply narrows the list of searched aliases to the folders with the given category. This makes `config.json` the single source of truth: changing a category works immediately and **does not require a reindex**.

The `config.json` files are read in parallel, and the folder → category map is kept in memory for 5 s (`CATEGORY_CACHE_TTL_MS`), because on an external drive a sequential read of 56 files on every search cost 0.7–3 s. A write through `PUT /api/folder/config` clears the cache immediately; a file changed by hand on disk becomes visible after at most 5 s.

### GET /api/videos/channels

The channels the search filter offers, the category of each one's folder, and the channel of every folder for the console's "search in this channel" link.

```json
{
  "channels": ["Alpha", "Beta"],
  "folders": { "/videos/alpha": "Alpha", "/videos/singles": "Somebody Else" },
  "channelCategories": { "Alpha": "fpv", "Beta": "psychology" }
}
```

`channels` holds only names a channel folder carries. A folder of single downloads (`kind: "collection"`) gathers channels from all over YouTube, so its one-off names would outnumber the real ones; they stay filterable through `?channel=` but are not offered. `channelCategories` omits a channel whose folder declares no category, and the client lists those without a header. `folders` maps every folder that has indexed videos to its most frequent channel name, which is what the console needs for its search link; the filter list comes from the channel folders alone.

The names come from one Elasticsearch aggregation over the folder path, with each folder's channel names as a sub-aggregation, and the categories are joined in from the same `config.json` read the category filter uses.

### GET /api/videos/file/:filename?folder=<path>

Serves video files (`.mp4`), thumbnails (`.webp`, `.jpg`, `.jpeg` and `.png`, numbered sizes included) and subtitles (`.vtt`).

**Parameters:**

- `filename` - the file name (e.g. `video.mp4`, `thumbnail.webp`)
- `folder` (optional, recommended) - the folder the file lives in; must be one of those configured in `VIDEOS_FOLDER_PATH` (otherwise 403). Without this parameter, the file is looked up by name in Elasticsearch. A GET that names its folder, carries no body and passes the auth does not count toward `RATE_LIMIT_MAX`, so a page of thumbnails and a playing video leave the request budget to the API calls. A read without `folder`, or one the auth refuses, still counts.

**Caching:** `.mp4` videos and thumbnails get `public, max-age=31536000, immutable`, because no job of the app writes new bytes under a media or thumbnail name that already exists. The name is not a content address, though: a file replaced by hand, or deleted and downloaded or repaired again under its old name, stays stale in a browser that cached it until eviction or a hard reload. A `.vtt` is `no-cache`, since a metadata update can replace it under the same name, and goes out with its cue settings stripped. Anything else (`.info.json`, `.description`, `.srt`) keeps the `no-store` of the rest of the API.

### GET /api/videos/:baseName/details

Returns detailed information about a video together with its comments. The title, description, date, counts and channel come from the video's document in the index, the same values search shows, so an `info.json` edited outside the app shows its new values once its folder is indexed again. Only the comments are read from `info.json`: the first 50 top-level comments come here, each with its replies, and `commentCount` counts the top-level comments.

**Parameters:**

- `baseName` - the base file name without extension

**Response:**

```json
{
  "details": {
    "title": "Video title",
    "description": "Full description...",
    "uploadDate": "20231201",
    "viewCount": 1000,
    "likeCount": 50,
    "channelName": "Channel name",
    "comments": [
      {
        "id": "comment_id",
        "author": "Comment author",
        "text": "Comment text",
        "like_count": 10,
        "timestamp": 1701446400,
        "replies": []
      }
    ],
    "commentCount": 25,
    "videoPath": "video_name.mp4",
    "thumbnailPath": "video_name.webp",
    "folderPath": "/path/to/folder"
  }
}
```

### Downloading from YouTube (`/api/folder/*`)

Endpoints for managing a channel folder (all require a `folderPath` from the `VIDEOS_FOLDER_PATH` list):

| Endpoint                                                | Description                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/status`                                       | List of folders and their `config.json`                                                                                                                |
| `PUT /api/folder/config`                                | Writes `config.json` (`{ folderPath, config: { channelUrl, category, ... } }`)                                                                         |
| `POST /api/folder/download-playlist`                    | `yt-dlp --flat-playlist -j` → `list.json`; an incomplete listing (`raise_incomplete_data`) fails with 500 and leaves `list.json` as it was. A request that arrives while the folder's listing runs waits for it and gets the same answer |
| `GET /api/folder/list-exists?folderPath=`               | Whether `list.json` exists                                                                                                                             |
| `GET /api/folder/list?folderPath=`                      | Contents of `list.json` + download statuses (from the folder index); a collection (`kind: "collection"`) lists its folder index instead, newest upload first |
| `GET /api/folder/summaries[?folderPath=]`               | Counts per folder for the channel console (`videos`, `downloaded`, `notDownloaded`, `unavailable`, `stale`, `newestUpdate`); every folder, cached 5 s, or one folder read fresh (the console asks for it when a job of that folder finishes) |
| `GET /api/folder/video-downloaded?folderPath=&videoId=` | Whether the video is downloaded                                                                                                                        |
| `GET /api/folder/state?folderPath=&filter=`             | Per-video state of the whole folder: what each video has on disk (video, thumbnail, description, subtitle languages, comments), what it is still missing, the videos only on disk (`orphans`) and how far `archive.txt` has drifted. `filter` is `all` (default), `incomplete`, `orphan` or `not-downloaded`; `counts` are always the unfiltered ones |
| `GET /api/folder/video-state?folderPath=&videoId=`       | One video's state, for the detail panel. `known: false` means neither the catalog nor the folder index holds that id |
| `POST /api/folder/archive/reconcile`                    | `{ folderPath, method: "add" \| "remove" \| "rebuild", videoIds? }` → `{ added, removed, unchanged, drift }`. `rebuild` and a `remove` without ids follow the disk, and both answer 409 while the folder holds no `.info.json` (a drive that is away) |
| `POST /api/folder/repair`                               | `{ folderPath, method: "sidecars" \| "comments", videos: [{ videoId }] }` → `202 { jobs, skipped }`. Queues `repair` jobs: `--skip-download` with the folder's sidecar flags and no `--download-archive`, so a subtitle that never arrived is actually fetched. `sidecars` runs with `--no-overwrites`: files already on disk stay as they are and only the missing ones are written. `comments` also refreshes the comment section, through the same staged merge as an `update` (see "Refreshing what is already archived"); at most 40,330 videos per request (400 beyond) |
| `POST /api/folder/rebuild-index`                        | Rebuilds the folder index from disk and adds the videos it found to `archive.txt`; it never removes an archive line (`archive/reconcile` does) |
| `POST /api/folder/queue`                                | Adds jobs to the queue: `{ folderPath, type: "download" \| "update", videos: [{ videoId, videoUrl?, title? }], force? }` → `202 { jobs, skipped }`; at most 40,330 videos per request (400 beyond) |
| `GET /api/folder/queue?folderPath=`                     | Queue state (`queued/running/done/error/cancelled`, progress, log tail)                                                                                |
| `POST /api/folder/queue/pause?paused=1`                 | Pauses the queue; `?paused=0` resumes it → `{ paused }`                                                                                                |
| `DELETE /api/folder/queue/finished`                     | Drops the finished (done/error/cancelled) jobs the queue keeps in memory → `{ cleared }`                                                               |
| `DELETE /api/folder/queue/:jobId`                       | Cancels a job (kills the process if running)                                                                                                           |
| `DELETE /api/folder/queue?folderPath=`                  | Cancels all jobs of a folder                                                                                                                           |
| `POST /api/folder/download-video`                       | Single download with an SSE stream (used by the Chrome extension); the job goes to the queue anyway, closing the connection does not stop the download; one the index already lists is answered "Already downloaded" (`downloadComplete`), with no job |

**The download queue** runs server-side (`server/src/services/downloadQueue.ts`): jobs are not tied to the HTTP request, so closing the tab does not stop `yt-dlp`. Three job types exist: `download` (whole video), `update` (metadata of a video already on disk) and `repair` (only the sidecars a folder asked for, `--skip-download`, never the media and never `--download-archive`; a sidecar repair also passes `--no-overwrites`, so it only adds what is missing). Downloads have their own limit; updates and repairs share one, because both write under an existing stem and neither needs a second process in the folder.

**Refreshing what is already archived.** An `update` and a comment repair (`method: "comments"`) ask yt-dlp for what YouTube serves today, which can be less than the archive holds. They write into a hidden `.videodeck-staging/<jobId>/` directory in the channel folder, and the server merges the result into the archive (`server/src/services/refreshStaging.ts`): the comment section is the union of the archived and the fresh list by comment id (the fresh copy wins, apart from the archived publish time); a top-level `info.json` field the run did not bring stays; a missing or blank description never replaces a real one; a subtitle or a description file that came back byte for byte the same is not touched; an archived thumbnail stays, and only a missing one is filled, as does a live chat replay; partial and unknown files are dropped. Subtitles follow their source: anything may replace machine captions, but an archived human track (listed under `subtitles` in the archived `info.json`, which keeps that record as a union by language) is replaced only by a human track, so machine captions never overwrite it, whether YouTube removed the human track or the folder's `--no-write-subs` skipped it. An archived subtitle whose source cannot be told (no readable archived `info.json`) stays too, and the `info.json` taken in its place records it in `_videodeck_kept_subtitles`. An `info.json` above 128 MiB, or one the server cannot read, is kept as it is, and the video stays as stale as it was. An archived `info.json` that does not parse is copied aside to `<stem>.info.json.unparseable-<time>` and replaced by the fresh one. A run whose files name another video (two videos sharing one file name, which only the older names without an id allow) fails and keeps every file. A run that fails, or a job cancelled before its merge, leaves the archive untouched. A comment refresh whose later comment pages YouTube refused (exit 1, no `comment_count`) is merged instead of retried. Staging directories left by a previous server process are removed at boot.

**The app decides what to download, not `archive.txt`.** A `download` for a video the folder index already has is skipped with `already downloaded`, and `update`/`repair` for a video the index lacks are skipped with `not downloaded`. An `update` or `repair` of a video whose file name holds a `$` is skipped with `unsafe file name`: yt-dlp expands environment variables in its output template, so the server never runs it on such a stem. The archive is a file plain `yt-dlp` runs write as well, and a video whose files were deleted stays in it, so "the archive lists it" and "the disk holds it" are different questions. `POST /api/folder/archive/reconcile` is what brings the two back together.

**Videos YouTube will not hand over are refused before a job exists.** Two sources answer "can this download succeed". The catalog carries the `availability` of the channel listing, where `subscriber_only` and `premium_only` are skipped as `members-only` and `premium-only`. The folder carries `.unavailable.json`, where the queue writes a failure that waiting cannot fix (`members-only`, `private`, `removed`, `geo-restricted`, `age-gate`) and keeps it for 30 days, or until a download of that video succeeds and clears it. `no-space` and `bot-wall` never enter the record: they describe the disk or the session, not the video. A skipped video comes back in `skipped` with the code as its `reason`, which the client translates through its own catalogs, and `force: true` in the request body queues one anyway.

The check only covers the `download` path. `update` and `repair` work on a file that is already on disk, so a failure there is about the files the operator asked to refresh, and it stays visible as a job error. `GET /api/folder/summaries` counts the affected videos as `unavailable`, apart from `notDownloaded`: a members-only video is not a download waiting to happen.

At most `DOWNLOAD_CONCURRENCY` downloads run in parallel (default 2) and only one per folder, because each appends to that folder's `archive.txt`. Metadata updates run at most `UPDATE_CONCURRENCY` (default 2), and also one at a time per folder: each writes only under its own file stem, and the folder index refresh after a job is queued per folder, so parallel jobs do not overwrite each other's `.videos-index.json`. Every write of that file takes its turn the same way, a rebuild and a collection read adding new videos included, so none of them saves over an entry another one has just added. When raising this limit, remember that every `yt-dlp` process (especially with `--write-comments`) means many requests to YouTube from a single IP address; 429 errors or a sign-in prompt are a signal to go back to a smaller value. The client polls `GET /api/folder/queue` every 1.5 s, only when there is something in the queue. The queue persists across server restarts: active jobs are re-enqueued on boot and the paused state is kept (`.queue-state.json`).

**Two kinds of jobs:**

- `download` - a full download with `--download-archive archive.txt`; a video whose id is already in `archive.txt` is not downloaded a second time, even if its title changed on YouTube. Its files are named `<upload_date>_<title>_<id>`, in ASCII (`--restrict-filenames`): without the id, titles that differ only in letters outside ASCII or punctuation, or in case on a case-insensitive drive, would share a name. Older files keep their `<upload_date>_<title>` names and work beside the new ones.
- `update` - metadata only (`--skip-download`) for the **existing** base file name, so no second set of files appears under a new title. It writes into `.videodeck-staging/<jobId>/` (`-o ".videodeck-staging/<jobId>/<baseName>.%(ext)s"`), and the server merges the result into the archive (see "Refreshing what is already archived").

**Folder index** (`server/src/services/folderIndex.ts`): every folder holds a hidden `.videos-index.json` file (`videoId → { baseName, videoFile, infoMtime, title, subtitleLangs, hasComments, hasDescription, hasThumbnail, videoBytes, infoBytes }`) plus yt-dlp's `archive.txt` and, once a download fails for a reason that waiting cannot fix, `.unavailable.json` (`videoId → { code, at }`). Version 2 added the per-file facts; an index written by an older build is rebuilt on the next read, which costs one full scan per folder and loses nothing, because the file is derived from disk state. Those facts are what `GET /api/folder/state` answers from, without walking the folder per video. Both files are built from disk on first use (no `info.json` that yt-dlp wrote is parsed whole: its head gives the id and the title yt-dlp writes first, and a scan that stops at the first comment tells whether comments and a description are there; a file whose id is not its first key is still parsed once, whole, for its id) and updated incrementally after every job, so `GET /api/folder/list` no longer parses all `info.json` files. After manually deleting files from the folder, call `POST /api/folder/rebuild-index`. A rebuild only ever adds archive lines, so to make the deleted videos downloadable again, follow it with `POST /api/folder/archive/reconcile` with `method: "remove"` and their `videoIds`. Avoid `rebuild` there: it also drops the lines of videos the index cannot read (a `.webm`, a video without its `info.json`). A collection has no jobs to trigger that refresh, so every read of its list or counts first adds the `info.json` files the index has never seen, whatever their mtime (yt-dlp runs in a terminal, files moved in from another folder).

## yt-dlp file format

The app expects the following file structure in the folder, where `video_name` is the stem: `<upload_date>_<title>_<id>`, or `<upload_date>_<title>` for files from before that rule:

```
folder/
├── video_name.description      # Video description (required for search)
├── video_name.mp4              # Video file
├── video_name.webp             # Thumbnail
├── video_name.info.json        # Metadata (title, stats, comments)
├── config.json                 # Channel configuration and download options (see below)
├── list.json                   # Channel video list (yt-dlp --flat-playlist)
├── archive.txt                 # yt-dlp archive (youtube <id>) - protects against duplicates
├── .videos-index.json          # Index of downloaded videos (generated automatically)
└── .videodeck-staging/         # Metadata refreshes in flight: a job's directory goes when the job ends, the empty parent at the next boot
```

The app automatically scans all configured folders and indexes files meeting the criteria above.

### config.json - per-folder channel configuration and download options

```json
{
  "channelUrl": "https://www.youtube.com/@channel",
  "category": "fpv",
  "maxHeight": 1080,
  "subLangs": ["pl", "en"],
  "writeComments": false,
  "extraArgs": ["--no-playlist"]
}
```

| Key                   | Default  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `channelUrl`          | -        | Channel address; `list.json` is generated from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kind`                | `"channel"` | `"collection"` marks a folder of single downloads (browser extension, yt-dlp in a terminal): no `channelUrl` and no `list.json`. Its video list and counts come from the folder index, and the channel console shows neither the channel warnings nor the playlist and download actions for it. The config form sets it with the "Kolekcja pojedynczych pobrań" box |
| `category`            | -        | Channel category (max. 64 characters, single line); allows narrowing the search to one topic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `maxHeight`           | `2160`   | Maximum video height (144-4320). Prefers h264/aac in mp4, then any codec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subLangs`            | `["en"]` | Subtitle languages for `--sub-lang` (`pl`, `en`, `en.*`, `all`). An empty array disables subtitles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `writeComments`       | `true`   | Whether to download comments (`--write-comments`) - they are indexed for search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `extraArgs`           | `[]`     | Extra yt-dlp flags appended after the built-in ones, e.g. `["--no-playlist"]` (separate entries as in argv, no quotes). Only the exact names in `ALLOWED_EXTRA_ARGS` (`server/src/services/folderConfig.ts`) are accepted, each with a checked value: the sleep and rate limits, `--retries`, `--match-filter`, `--no-playlist`, `--no-warnings` and the `--no-write-*` switches. For anything else `PUT /api/folder/config` answers 400 and names the allowed flags, a hand-edited file drops the entry together with its value, and the argument builder refuses it again before yt-dlp starts |
| `impersonate`         | `false`  | Adds `--impersonate chrome`, impersonating a browser without cookies (no cookie flag is accepted in `extraArgs`); helps when YouTube responds with 429 or treats the server as a bot                                                                                                                                                                                                                                                                                                                                                                                                     |
| `concurrentFragments` | `1`      | Number of parallel download fragments (`-N`, 1-16); higher values speed up downloads because YouTube throttles a single connection                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sponsorblockRemove`  | `false`  | Adds `--sponsorblock-remove sponsor,selfpromo,interaction`, cuts sponsor segments at download time (ffmpeg, cuts at keyframes without re-encoding)                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Missing keys fall back to their defaults (`GET /api/status` returns them in `downloadDefaults`). Invalid values in a hand-edited file are ignored, and `PUT /api/folder/config` rejects them. Options are read at the moment a job is added to the queue. The UI editor (status page) lets you set them without editing the file by hand.

### Adding subtitles in another language (without re-downloading)

To pull in, say, Polish subtitles next to the English ones for an already downloaded channel:

1. In the channel's `config.json` set `subLangs: ["en", "pl"]` and add to `extraArgs`:
   `["--no-write-comments", "--no-write-info-json", "--no-write-thumbnail", "--no-write-description"]`
   Updates will then download **only subtitles**: no comments (the slowest part)
   and no overwriting of `info.json` (existing comments and metadata stay untouched).
2. In the channel's section on the status page, click **"Update all"** (pl: „Aktualizuj wszystkie") or **"Update old"** (pl: „Aktualizuj stare")
   for videos older than a month), the queue downloads the new `.pl.vtt` files under the existing
   file names.
3. The new subtitles are visible in the player immediately (the details endpoint reads the `.vtt` files from disk)
   No reindex needed. You can raise the pace with the `UPDATE_CONCURRENCY` variable (default: 2 parallel).
   Once done, clear `extraArgs` if you want to go back to full updates.
