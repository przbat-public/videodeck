# Deployment (Docker)

The compose stack bundles Elasticsearch, the API server and the static web
client. The Chrome extension keeps running on the operator's machine and
points at `http://<host>:3001`.

## Prerequisites

- Docker with the compose plugin
- Your video library reachable from the machine running the stack

## First run

1. Edit `docker-compose.yml` and set the mount:
   ```yaml
   volumes:
     - /path/to/videos:/videos
   ```
   (`/path/to/videos` is your library root; the container path must match
   `VIDEOS_FOLDER_PATH`.)

2. Generate an API token and set it in `.env` next to the compose file
   (the compose file reads `${API_TOKEN}`):
   ```bash
   openssl rand -hex 32
   ```
   With `REQUIRE_API_TOKEN=true` (the compose default) the API refuses all
   requests without the token — configure the same token in the Chrome
   extension options.

3. Bring the stack up:
   ```bash
   docker compose up -d --build
   ```
   - Web UI: `http://<host>:3000`
   - API: `http://<host>:3001` (`/health`, `/api/...`)
   - First searchable content appears after `POST /api/videos/refreshCache`
     (or the "Refresh index" — pl: "Odśwież indeks" — button on the status page).

## Upgrades

```bash
docker compose pull && docker compose up -d --build
```

After an upgrade, check the boot log for the "index mapping uses analyzer …"
warning: a mapping change requires a reindex (`POST /api/videos/refreshCache`).
Elasticsearch data is rebuildable at any time — the video folders are the
store of record.

### Restarts and the download queue

The queue persists its active jobs to `.queue-state.json` (in the server
working directory) and re-enqueues them on boot, so `docker compose restart`
resumes interrupted work automatically: downloads dedup against `archive.txt`
and index updates are idempotent re-scans. The state file lives in the
container filesystem — recreating the container (`docker compose down` +
`up`) discards it, which only cancels queued jobs; already downloaded videos
are unaffected.

## Backups

The folders themselves are the source of truth. Per folder, the files worth
backing up together with the videos:

- `config.json` — channel URL + download options
- `list.json` — the channel's video list
- `archive.txt` — download dedup (losing it re-downloads re-titled re-uploads)
- `.videos-index.json` — local download-status index (rebuildable)

Elasticsearch volumes can be discarded and rebuilt via a full reindex.
