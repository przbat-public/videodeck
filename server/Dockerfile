# Server image: Node 22 + yt-dlp (nightly) + ffmpeg. Video folders are
# mounted at runtime (see docker-compose.yml).
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    # The nightly channel is recommended — YouTube breaks old releases.
    && python3 -m pip install --break-system-packages -U --pre yt-dlp

WORKDIR /app

# Root package first: shared/*.ts resolves zod from the repo root.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY shared ./shared
COPY server ./server
RUN cd server && npm run build

WORKDIR /app/server

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/server/src/index.js"]
