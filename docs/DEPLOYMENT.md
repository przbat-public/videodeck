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

   **Removable drives: mount the parent, not the drive.** A bind mount is fixed
   when the container is created, so a path that points at one drive cannot see
   a drive mounted later, and the server's watch cannot help. Mount the
   directory the drives appear in and let `VIDEOS_FOLDER_PATH` glob over it:

   ```yaml
   volumes:
     - /Volumes:/volumes
   ```
   ```
   VIDEOS_FOLDER_PATH=/volumes/*/*
   ```

   The container then sees every mount and unmount as it happens. Docker
   Desktop on macOS has to share the directory first (Settings, Resources,
   File sharing), which `/Volumes` is part of by default.

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

   AI summaries are optional. Put `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` in the
   same `.env` next to the compose file: the stack passes both, together with
   `SUMMARY_PROVIDER` and `DEEPSEEK_MODEL`. With both keys set DeepSeek answers,
   unless `SUMMARY_PROVIDER` pins OpenAI. See the summary section in
   [INSTALL.md](INSTALL.md).

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

## Troubleshooting

### The stack refuses to come up, and Elasticsearch is the reason

Elasticsearch is a JVM, and it is the slowest service in this stack to start.
Nothing behind it starts until it reports healthy. A node that was stopped
abruptly (Docker Desktop quit, host reboot, VM killed) recovers its translog on
the next boot, so a start that follows a hard stop takes longer than a clean
one. When the healthcheck never passes, the run ends with
`dependency failed to start` and the server stays down.

The compose file allows a start period of one minute and five minutes of
retries. That covers most boots. When it does not, ask the container what it
thinks:

```bash
docker compose ps                              # health of every service
docker compose logs elasticsearch | tail -40   # why the JVM stopped or stalled
docker inspect -f '{{.State.ExitCode}} {{.State.Health.Status}}' \
  "$(docker compose ps -q elasticsearch)"
curl -s 'http://localhost:9200/_cluster/health?pretty'
```

Two failures have a signature of their own.

**Exit code 78, with `max virtual memory areas vm.max_map_count [65530] is too
low` in the log.** That is the bootstrap check Elasticsearch runs when it binds
to a non-loopback address. Docker Desktop lowered this kernel setting in 4.25
and restored it in 4.26. Check what the engine sees. Update Docker Desktop if
the number is wrong. The command below has to print `262144`:

```bash
docker run --rm alpine cat /proc/sys/vm/max_map_count
```

**`Bind for 127.0.0.1:9200 failed: port is already allocated`.** Something else
holds the port. That is usually a local Elasticsearch from Homebrew, or a
container that belongs to another project. This names the process:

```bash
lsof -nP -iTCP:9200 -sTCP:LISTEN
```

Elasticsearch holds nothing worth keeping, so a volume left half-written costs
a reindex and nothing else. Replacing it takes three commands:

```bash
docker compose rm -sf elasticsearch
docker volume rm "$(basename "$PWD")_es-data"
docker compose up -d
```

Then `POST /api/videos/refreshCache` rebuilds the index from the folders.

### Docker itself stops answering

Some symptoms belong to Docker Desktop, not to this stack. `docker ps` hangs.
Every command times out. The engine answers nothing on its socket. Containers
that cannot reach the engine surface in the app as connect errors, so rule this
out first with one command that should return instantly:

```bash
curl -s --unix-socket ~/.docker/run/docker.sock http://localhost/_ping
```

Docker Desktop keeps its VM disk on the host, and a host volume with almost no
free space stalls writes inside the VM. The engine goes down with it. Leave
several gigabytes free, quit Docker Desktop completely
(`osascript -e 'quit app "Docker"'`), and start it again.

## Backups

The folders themselves are the source of truth. Per folder, the files worth
backing up together with the videos:

- `config.json`: channel URL + download options
- `list.json`: the channel's video list
- `archive.txt`: download dedup (losing it re-downloads re-titled re-uploads)
- `.videos-index.json`: local download-status index (rebuildable)

Elasticsearch volumes can be discarded and rebuilt via a full reindex.
