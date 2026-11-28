# Server image: Node + yt-dlp (pinned, with curl_cffi and deno) + ffmpeg. Two
# stages keep the dev dependencies and their build cache out of the runtime
# layer, and the runtime runs as the unprivileged `node` user. Video folders
# are mounted at runtime (see docker-compose.yml).

# --- build ------------------------------------------------------------------
FROM node:24-slim AS build

RUN corepack enable

WORKDIR /app

# pnpm workspace: the lockfile + every package manifest must exist before
# install; sources come afterwards in their own layer. `tsconfig.base.json` is
# part of the build, not the install: both package configs extend it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY client/package.json ./client/
COPY chrome-extension/package.json ./chrome-extension/
COPY test-infra/package.json ./test-infra/
RUN pnpm install --frozen-lockfile

COPY shared ./shared
COPY server ./server
RUN cd server && pnpm run build

# --- runtime ----------------------------------------------------------------
FROM node:24-slim AS runtime

# Pinned on purpose. The docs recommend the nightly channel for a hand install
# because YouTube breaks old releases, but a rebuild of a running deployment
# must not silently swap the downloader underneath it: bump this argument when
# you mean to. Nothing older than 2026.10.26: every earlier release pins a
# brotli, a certifi or a urllib3 with a published advisory
# (scripts/check-server-image.test.mjs). From that release on yt-dlp needs
# Python 3.11, the version the bookworm base ships.
ARG YTDLP_VERSION=2026.11.23
# A bare yt-dlp installs none of its dependencies: each one sits behind an
# extra. The pin extras add them at the versions that release names, so the
# pin above holds for the whole tree. `pin` is the default set, yt-dlp-ejs and
# its challenge scripts among it; `pin-curl-cffi` is what `impersonate: true`
# loads; `pin-deno` is the runtime the challenge scripts run in. yt-dlp finds
# deno by itself and starts it with no permissions, so the YouTube player code
# it runs reaches neither the network nor the environment, which holds the API
# keys.
ARG YTDLP_EXTRAS=pin,pin-curl-cffi,pin-deno

# Wheels only (--only-binary): nothing compiles from a source archive as root,
# and a platform that lacks a wheel fails the build with the package's name.
RUN corepack enable \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir --only-binary=:all: \
    "yt-dlp[${YTDLP_EXTRAS}]==${YTDLP_VERSION}" \
    # The queue state file lives here (QUEUE_STATE_FILE below): outside the app
    # tree, so the unprivileged user can write it.
    && mkdir -p /app/state \
    && chown node:node /app/state

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY client/package.json ./client/
COPY chrome-extension/package.json ./chrome-extension/
COPY test-infra/package.json ./test-infra/
# Production dependencies only, and no lifecycle scripts: nothing the server
# needs at runtime has a postinstall step, and skipping them keeps the build
# from executing package code as root. The filter keeps the install to the
# server and the workspace package it runs on (shared): without it the image
# carried the client's packages and the test tooling as well. A plain --filter
# would follow the server's devDependencies into test-infra, and
# --fail-if-no-match turns a renamed package into a failed build instead of an
# empty install.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
    --filter-prod 'video-search-server...' --fail-if-no-match

# `shared` stays source: the server imports the workspace package, and Node
# strips the types at load time.
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/dist ./server/dist

ENV NODE_ENV=production
ENV QUEUE_STATE_FILE=/app/state/.queue-state.json
# Mount this to keep queued jobs across a container recreate, not just a
# restart.
VOLUME ["/app/state"]

EXPOSE 3001
# Video folders must be writable by this user: the folder index and archive
# live next to the videos. See docs/DEPLOYMENT.md.
USER node
# Liveness only: /health/live answers while Elasticsearch is down, so a cluster
# outage does not mark this container unhealthy. Docker reports the state
# (docker compose ps, up --wait) and restarts nothing. The slim base has no
# curl, so node asks; 127.0.0.1 reaches both binds the docs describe, the
# default loopback and the 0.0.0.0 the compose stack sets. The start period
# covers a boot that restores a long queue. No --start-interval: Docker Engine
# 24 and older refuse the flag, and the whole build with it, while Engine 27
# and later probe every 5 s during the start period without being asked.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/dist/server/src/index.js"]
