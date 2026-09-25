# Server image: Node + yt-dlp (pinned) + ffmpeg. Two stages keep the dev
# dependencies and their build cache out of the runtime layer, and the runtime
# runs as the unprivileged `node` user. Video folders are mounted at runtime
# (see docker-compose.yml).

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
# you mean to.
ARG YTDLP_VERSION=2026.8.19

RUN corepack enable \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir "yt-dlp==${YTDLP_VERSION}" \
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
# from executing package code as root.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

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
CMD ["node", "server/dist/server/src/index.js"]
