# API and file format reference

The HTTP endpoints, the Elasticsearch indexing model behind search, the
on-disk yt-dlp file layout and the per-channel `config.json` options.

## API Endpoints

### GET /health (public)

Readiness probe: pings Elasticsearch and returns `200 { status: 'ok', elasticsearch: 'ok' }`, and when ES does not respond: `503 { status: 'degraded', elasticsearch: 'down' }`. The Chrome extension uses it in its "Test connection" (pl: „Test połączenia") button. The ping result is cached for 5 s, so frequent polling does not burden ES.

### GET /health/live (public)

Dependency-free liveness probe: `200 { status: 'ok' }` when the server process responds.

### GET /metrics (public)

Prometheus: `http_requests_total` and `http_request_duration_seconds` (method/route/status labels; unknown paths go to the `unmatched` label so as not to multiply series per URL), `download_queue_size`, and summary cost metrics: `openai_summary_requests_total`, `openai_summary_tokens_total`, `openai_summary_estimated_cost_cents_total` (a USD estimate based on approximate model pricing).

### GET /api/videos/refreshCache

Refreshes and reindexes all videos from the configured folders into Elasticsearch.

**Response:**

```json
{
  "message": "Cache refresh process started",
  "status": "ok"
}
```

**Cache on removable drives.** Each folder's index lives in Elasticsearch under an alias computed from the folder path and **survives unplugging the drive**. After swapping drives, search immediately uses the aliases of the currently attached folders (the previous drive is simply not searched), and the status page shows only the missing index per folder (`indeks ES: brak`, "ES index: missing"). Instead of a full reindex, it is then enough to call:

```
GET /api/videos/refreshCache?onlyMissing=1
```

, only folders without an existing index are reindexed (e.g. a drive attached for the first time); folders with a cache are skipped and keep serving search. In the web UI this is the **"only missing (use existing index)"** checkbox (pl: „tylko brakujące (użyj istniejącego indeksu)") next to the "Refresh index" button (pl: „Odśwież indeks"). A full reindex (without the parameter) remains for situations where the drive contents changed and the existing index must be rebuilt.

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
  "errors": []
}
```

`filesDone/filesTotal` refer to the current folder, `indexed/skipped` to the whole run. `errors` is the list of folders that failed to index (max. 20 entries), `lastError` the last error message, and `finishedAt` appears once finished.

#### How the reindex works

Every folder has an **alias** `videos_<sha256(folderPath)[:16]>` in Elasticsearch, pointing at exactly one physical index `videos_<hash>_<timestamp>`. The reindex:

1. creates a new, empty physical index,
2. reads `info.json` from disk and writes documents in batches (`_bulk`): at most 50 documents or ~16 MB per request, because channels with tens of thousands of comments have `info.json` files of 50 MB and Elasticsearch rejects requests above 100 MB,
3. once the whole folder is written, atomically switches the alias to the new index (`_aliases`) and deletes the previous one.

Thanks to this, search works the whole time on the old index version, and an interrupted reindex (error, server restart) does not leave an empty index. At most an orphaned `videos_<hash>_<timestamp>` index remains, which is removed at the next successful reindex of that folder. Videos with the same `videoId` (duplicates on disk) go into a single document.

Comments are **not** stored in ES as objects. Only one text field, `commentsText`, which search runs over. The `GET /api/videos/:id/details` endpoint reads the full comment tree from `info.json`. The `commentsText` field is not returned in search results.

After every download-queue job (`download`/`update`), the changed videos are indexed incrementally, so a new video is visible in search without a full reindex.

**Changing the analyzer requires a reindex:** existing indexes keep the
mappings from their creation time, so after an upgrade that changes text
analysis (e.g. introducing `polish_folded`), call `GET /api/videos/refreshCache`. New
indexes get the new analyzer, and the aliases switch atomically.

### GET /api/videos/search

Searches videos by phrase in the file name (`baseName.text^4`), title (`^3`), description (`^2`), subtitle transcript (`transcriptText^2`), and comments (`commentsText`). Text is analyzed with **diacritic folding** (custom `polish_folded` analyzer: `standard` + `lowercase` + `asciifolding`), so `srodek` finds `środek` without typing Polish characters. Polish stemming/stop words would require the `analysis-stempel` plugin (absent from the default Docker image), so the analyzer uses only built-in components. Transcripts and comments are search-only fields; they are never returned in responses.

**Query parameters:**

- `q` (optional) - search phrase
- `sort` (optional) - sort order:
  - `relevance` - by relevance (default Elasticsearch behavior, `_score`; only meaningful with a phrase)
  - `date-desc` - by date, newest first (default)
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

### GET /api/videos/categories

Categories declared in the `config.json` files of the configured folders - sorted, without duplicates (variants differing only in case are merged). Feeds the picker in search.

```json
{ "categories": ["fpv", "lego", "psychology"] }
```

The category **does not go into Elasticsearch**. Every folder has its own index alias, so the filter simply narrows the list of searched aliases to the folders with the given category. This makes `config.json` the single source of truth: changing a category works immediately and **does not require a reindex**.

The `config.json` files are read in parallel, and the folder → category map is kept in memory for 5 s (`CATEGORY_CACHE_TTL_MS`), because on an external drive a sequential read of 56 files on every search cost 0.7–3 s. A write through `PUT /api/folder/config` clears the cache immediately; a file changed by hand on disk becomes visible after at most 5 s.

### GET /api/videos/file/:filename?folder=<path>

Serves video files (.mp4) and thumbnails (.webp).

**Parameters:**

- `filename` - the file name (e.g. `video.mp4`, `thumbnail.webp`)
- `folder` (optional, recommended) - the folder the file lives in; must be one of those configured in `VIDEOS_FOLDER_PATH` (otherwise 403). Without this parameter, the file is looked up by name in Elasticsearch.

### GET /api/videos/:baseName/details

Returns detailed information about a video together with its comments.

**Parameters:**

- `baseName` - the base file name without extension

**Response:**

```json
{
  "details": {
    "title": "Video title",
    "description": "Full description...",
    "uploadDate": "20231201",
    "duration": "10:30",
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
| `POST /api/folder/download-playlist`                    | `yt-dlp --flat-playlist -j` → `list.json`                                                                                                              |
| `GET /api/folder/list-exists?folderPath=`               | Whether `list.json` exists                                                                                                                             |
| `GET /api/folder/list?folderPath=`                      | Contents of `list.json` + download statuses (from the folder index)                                                                                    |
| `GET /api/folder/video-downloaded?folderPath=&videoId=` | Whether the video is downloaded                                                                                                                        |
| `POST /api/folder/rebuild-index`                        | Rebuilds the folder index and `archive.txt` from disk                                                                                                  |
| `POST /api/folder/queue`                                | Adds jobs to the queue: `{ folderPath, type: "download" \| "update", videos: [{ videoId, videoUrl?, title? }] }` → `202 { jobs, skipped }`             |
| `GET /api/folder/queue?folderPath=`                     | Queue state (`queued/running/done/error/cancelled`, progress, log tail)                                                                                |
| `POST /api/folder/queue/pause?paused=1`                 | Pauses the queue; `?paused=0` resumes it → `{ paused }`                                                                                                |
| `DELETE /api/folder/queue/finished`                     | Drops the finished (done/error/cancelled) jobs the queue keeps in memory → `{ cleared }`                                                               |
| `DELETE /api/folder/queue/:jobId`                       | Cancels a job (kills the process if running)                                                                                                           |
| `DELETE /api/folder/queue?folderPath=`                  | Cancels all jobs of a folder                                                                                                                           |
| `POST /api/folder/download-video`                       | Single download with an SSE stream (used by the Chrome extension); the job goes to the queue anyway, closing the connection does not stop the download |

**The download queue** runs server-side (`server/src/services/downloadQueue.ts`): jobs are not tied to the HTTP request, so closing the tab does not stop `yt-dlp`. Downloads and updates have separate limits. At most `DOWNLOAD_CONCURRENCY` downloads run in parallel (default 2) and only one per folder, because each appends to that folder's `archive.txt`. Metadata updates run at most `UPDATE_CONCURRENCY` (default 2), and also one at a time per folder: each writes only under its own file stem, and the folder index refresh after a job is queued per folder, so parallel jobs do not overwrite each other's `.videos-index.json`. When raising this limit, remember that every `yt-dlp` process (especially with `--write-comments`) means many requests to YouTube from a single IP address; 429 errors or a sign-in prompt are a signal to go back to a smaller value. The client polls `GET /api/folder/queue` every 1.5 s, only when there is something in the queue. The queue persists across server restarts: active jobs are re-enqueued on boot and the paused state is kept (`.queue-state.json`).

**Two kinds of jobs:**

- `download` - a full download with `--download-archive archive.txt`; a video whose id is already in `archive.txt` is not downloaded a second time, even if its title changed on YouTube.
- `update` - metadata only (`--skip-download`), saved under the **existing** base file name (`-o "<baseName>.%(ext)s"`), so `info.json`, the description, the thumbnail, and subtitles are overwritten in place, not created under a new title.

**Folder index** (`server/src/services/folderIndex.ts`): every folder holds a hidden `.videos-index.json` file (`videoId → { baseName, videoFile, infoMtime }`) plus yt-dlp's `archive.txt`. Both are built from disk on first use (only the header of each `info.json` is read) and updated incrementally after every job, so `GET /api/folder/list` no longer parses all `info.json` files. After manually deleting files from the folder, call `POST /api/folder/rebuild-index`.

## yt-dlp file format

The app expects the following file structure in the folder:

```
folder/
├── video_name.description      # Video description (required for search)
├── video_name.mp4              # Video file
├── video_name.webp             # Thumbnail
├── video_name.info.json        # Metadata (title, stats, comments)
├── config.json                 # Channel configuration and download options (see below)
├── list.json                   # Channel video list (yt-dlp --flat-playlist)
├── archive.txt                 # yt-dlp archive (youtube <id>) - protects against duplicates
└── .videos-index.json          # Index of downloaded videos (generated automatically)
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
| `category`            | -        | Channel category (max. 64 characters, single line); allows narrowing the search to one topic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `maxHeight`           | `2160`   | Maximum video height (144-4320). Prefers h264/aac in mp4, then any codec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subLangs`            | `["en"]` | Subtitle languages for `--sub-lang` (`pl`, `en`, `en.*`, `all`). An empty array disables subtitles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `writeComments`       | `true`   | Whether to download comments (`--write-comments`) - they are indexed for search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `extraArgs`           | `[]`     | Extra yt-dlp flags appended after the built-in ones, e.g. `["--no-playlist"]` (separate entries as in argv, no quotes). Reserved are the flags the pipeline relies on: `-f/--format`, `-o/--output`, `-P/--paths`, `--download-archive`, `--no-download-archive`, `--merge-output-format`, and forbidden (security): `--exec`, `--config-locations`, `--cookies`/`--load-cookies`/`--cookies-from-browser`, `--proxy`, `--netrc`, `--username`, `--password`, `--video-password`. `PUT /api/folder/config` rejects them, and in a hand-edited file they are ignored (together with their value) |
| `impersonate`         | `false`  | Adds `--impersonate chrome`, impersonating a browser without cookies (a safe alternative to the forbidden `--cookies*`); helps when YouTube responds with 429 or treats the server as a bot                                                                                                                                                                                                                                                                                                                                                                                                     |
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
