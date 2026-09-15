# Server image: Node 22 + yt-dlp (nightly) + ffmpeg. Video folders are
# mounted at runtime (see docker-compose.yml). Installed via pnpm (the
# workspace root carries the lockfile; a full install keeps the image
# simple — the build needs dev dependencies for tsc).
FROM node:22-slim

RUN corepack enable \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    # The nightly channel is recommended — YouTube breaks old releases.
    && python3 -m pip install --break-system-packages -U --pre yt-dlp

WORKDIR /app

# pnpm workspace: the lockfile + every package manifest must exist before
# install; sources come afterwards in their own layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY client/package.json ./client/
COPY chrome-extension/package.json ./chrome-extension/
COPY test-infra/package.json ./test-infra/
RUN pnpm install --frozen-lockfile

COPY shared ./shared
COPY server ./server
RUN cd server && pnpm run build

WORKDIR /app/server

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/server/src/index.js"]
