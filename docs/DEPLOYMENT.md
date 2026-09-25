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
   requests without the token. The `client` container receives the same
   `API_TOKEN` and adds the `Authorization` header to every `/api` request it
   proxies, so the web UI works without the browser ever holding the token.
   Configure the same token in the Chrome extension options: the extension
   talks to the API directly.
   That makes the `client` port as powerful as the token. Reaching it is
   enough to drive the whole API through the proxy: reindex the library,
   drain the download queue, rewrite a folder config. The shipped compose
   file binds both ports to `127.0.0.1` for that reason. Publish them wider
   only behind something that authenticates first, and keep `API_TOKEN` out
   of reach. A random website cannot do it from a browser, because nginx and
   the server both turn cross-site requests away, token or no token.

3. Bring the stack up:
   ```bash
   docker compose up -d --build
   ```
   - Web UI: `http://<host>:3000`
   - API: `http://<host>:3001` (`/health`, `/api/...`)
   - First searchable content appears after `POST /api/videos/refreshCache`
     (or the "Refresh index", pl: "Odśwież indeks", button on the status page).

## Upgrades

```bash
docker compose pull && docker compose up -d --build
```

After an upgrade, check the boot log for the "index mapping uses analyzer …"
warning: a mapping change requires a reindex (`POST /api/videos/refreshCache`).
Elasticsearch data is rebuildable at any time. The video folders are the
store of record.

### Restarts and the download queue

The queue persists its active jobs to `.queue-state.json` and re-enqueues them
on boot, so `docker compose restart` resumes interrupted work automatically:
downloads dedup against `archive.txt` and index updates are idempotent
re-scans. In the image the file lives in `/app/state`, which the compose file
mounts as the `queue-state` volume, so `docker compose down` + `up` keeps the
queue too. Drop that volume to discard it, which only cancels queued jobs;
already downloaded videos are unaffected.

### File ownership

The server runs as the unprivileged `node` user (uid 1000), in the image and
in the compose stack alike. Whatever folder you mount has to be writable by
that account. The server writes several files next to the videos:

- `.videos-index.json`: the local download index
- `archive.txt`: the dedup file that stops re-downloads
- the video files themselves
- `config.json` and `list.json`, when you edit a channel from the console

On a Linux host, the usual fix is one command:

```bash
sudo chown -R 1000:1000 /path/to/videos
```

On a network share, map every client onto one account instead of chasing
ownership of individual files: set the share's `uid` and `gid` mount options.

## Backups

The folders themselves are the source of truth. Per folder, the files worth
backing up together with the videos:

- `config.json`: channel URL + download options
- `list.json`: the channel's video list
- `archive.txt`: download dedup (losing it re-downloads re-titled re-uploads)
- `.videos-index.json`: local download-status index (rebuildable)

Elasticsearch volumes can be discarded and rebuilt via a full reindex.
