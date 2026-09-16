# Installation and configuration

The full setup walkthrough: Elasticsearch options, environment variables,
removable-drive folder patterns, production builds and type checking. The
README's quickstart covers the happy path in three commands; come here for
the rest.

## Setup

1. Install dependencies for the whole pnpm workspace (backend, frontend,
   Chrome extension, shared contract and test infrastructure):

```bash
pnpm install          # or: pnpm run install:ci for a frozen CI-style install
```

2. Start Elasticsearch:

**Option A: Docker (recommended)**

First make sure Docker Desktop is running:

- On macOS: open the "Docker Desktop" app from the Applications folder or use Spotlight (Cmd+Space → "Docker")
- Check that Docker works: `docker ps` (should run without errors)

Then start Elasticsearch (ports bound to loopback; there is no password, so ES must not be reachable from the network):

```bash
docker run -d -p 127.0.0.1:9200:9200 -p 127.0.0.1:9300:9300 -e "discovery.type=single-node" -e "xpack.security.enabled=false" -e "xpack.security.enrollment.enabled=false" docker.elastic.co/elasticsearch/elasticsearch:9.5.1
```

**Option B: Homebrew (macOS)**

If you prefer to install Elasticsearch locally without Docker:

```bash
brew install elasticsearch
brew services start elasticsearch
```

**Option C: Download and manual installation**

Per the [official Elasticsearch documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/install-elasticsearch.html).

**Checking whether Elasticsearch is running:**

```bash
curl http://localhost:9200
```

You should see a JSON response with information about Elasticsearch.

3. Configure environment variables:

Create a `server/.env` file (the server loads it from its own directory ,
`dotenv.config()` runs with cwd=`server/`; a root-level `.env` is ignored):

```bash
VIDEOS_FOLDER_PATH=/path/to/videos/folder
ELASTICSEARCH_URL=http://localhost:9200
```

Example for a single folder:

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-channel
ELASTICSEARCH_URL=http://localhost:9200
```

Example for multiple folders (separated by semicolon or comma):

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/folder1;/Volumes/MEDIA/folder2;/Volumes/MEDIA/folder3
ELASTICSEARCH_URL=http://localhost:9200
```

**Folders on removable drives**: instead of swapping lines each time you swap the drive, use a glob pattern. `*` matches one path segment, and a directory containing `config.json` or `*.info.json` is treated as a channel folder:

```
VIDEOS_FOLDER_PATH=/Volumes/*/*
```

This single line finds all channels on every currently mounted volume. A drive that is absent simply contributes no folders (the server starts with a warning and picks the folders up when the drive comes back; the list is refreshed every few seconds). You can mix patterns with literals (`~/` expands to the home directory):

```
VIDEOS_FOLDER_PATH=/Volumes/MEDIA/example-*;/Volumes/MEDIA/*;/Users/<user>/Downloads/youtube/youtube-chrome
```

Optional variables:

```
DOWNLOAD_CONCURRENCY=2      # max. number of parallel yt-dlp downloads (default 2, at most one per folder)
UPDATE_CONCURRENCY=2        # max. number of parallel metadata updates (default 2, no per-folder limit)
DOWNLOAD_MAX_ATTEMPTS=3     # how many times to retry a failed yt-dlp (30 s backoff; YouTube 429 etc.)
LOG_LEVEL=info              # log level: info (default), warn, error, silent
OPENAI_API_KEY=sk-REPLACE-ME  # key for AI summaries (GET /api/videos/:id/summary)
HOST=127.0.0.1              # server bind address (defaults to loopback)
API_TOKEN=secret            # bearer token protecting /api (see the Security section in the README)
CORS_ORIGINS=https://example.com  # extra CORS origins (comma-separated), beyond localhost and chrome-extension://
ALLOWED_HOSTS=nas.local,192.168.0.10  # extra hostnames/IPs allowed in the Host header (needed with HOST=0.0.0.0)
EXTENSION_ORIGINS=chrome-extension://abcdefghijklmnop  # exact extension id allowed by CORS (without it: any chrome-extension://)
RATE_LIMIT_MAX=2000         # HTTP request limit per time window per IP (default 2000)
RATE_LIMIT_WINDOW_MS=600000 # rate-limit window length in ms (default 10 minutes)
```

**Note:**

- If Elasticsearch runs on a different host or port, update `ELASTICSEARCH_URL` accordingly.
- If you use Docker and get a "Cannot connect to the Docker daemon" error, make sure Docker Desktop is running.
- After starting the server for the first time, you must manually call the `/api/videos/refreshCache` endpoint to index videos into Elasticsearch (this may take a while depending on the number of videos). The same applies after an upgrade that changes the search analyzer (see [docs/API.md](API.md)).
- **Keep yt-dlp up to date**: YouTube regularly breaks older versions. yt-dlp recommends the `nightly` channel (stable tends to be "stale and prone to external breakage"); the version is shown in the server startup log (`yt-dlp version: ...`), and when downloads start failing with "Sign in to confirm you're not a bot"/429 errors, the first thing to try is `yt-dlp -U` or the `nightly` channel. In a channel's `config.json` you can also enable `impersonate: true` (browser impersonation, without cookies).


## Production builds and type checking

### Production build

**Backend:**

```bash
pnpm run build:server
cd server && pnpm run start:prod
```

The build uses `server/tsconfig.build.json` (without tests and `test-utils.ts`). Because the server also compiles the shared types from `shared/`, `rootDir` points at the repo root and the output lands in `server/dist/server/src/index.js`. `start:prod` and the `main` field in `package.json` already account for this.

**Frontend:**

```bash
pnpm run build:client
cd client && pnpm run preview
```

**Chrome extension:**

```bash
pnpm run build:extension   # esbuild → background/content/popup/options.js
```

The generated `chrome-extension/*.js` files are not committed (gitignore) ,
after cloning the repo, the extension must be built before loading it into
Chrome.

### Type checking (no emit)

```bash
pnpm run typecheck                        # all three projects
cd server && pnpm run typecheck           # tsconfig.json (code + tests)
cd client && pnpm run typecheck           # tsconfig.json + tsconfig.node.json (vite.config.ts)
cd chrome-extension && pnpm run typecheck # src/ + shared/api.ts (shared contract)
```
