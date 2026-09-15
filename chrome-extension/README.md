# Chrome Extension - Video Downloader

A Chrome extension that enqueues videos from the browser into the
video-search-app server's download queue.

## Installation

1. Install dependencies and build the extension (the source is TypeScript in
   `src/`; Chrome loads the generated `*.js` files from this directory):

   ```bash
   npm install
   npm run build
   ```

2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the `chrome-extension` folder of this project

After changing code in `src/`, re-run `npm run build` and click the refresh
icon next to the extension in `chrome://extensions/`.

## Configuration

1. Right-click the extension icon and choose "Options"
2. Fill in:
   - **Server URL**: the video-search-app server URL (e.g. `http://localhost:3001`)
   - **Folder path**: the folder videos should be saved to (must be listed in
     the server's `VIDEOS_FOLDER_PATH`)
   - **API token** (optional): the server's `API_TOKEN` value, sent as
     `Authorization: Bearer ...`; fill in only when the server has a token set
3. Click "Test connection" to check whether the server responds
4. Click "Save" to store the settings

## Usage

1. Open a page with a video (e.g. YouTube)
2. Click the extension icon in the toolbar
3. Click "Download video"
4. The download progress is shown live in the popup

## Features

- Automatic video detection on the page (YouTube, direct video links)
- Downloads through `/api/folder/download-video` (the job runs in the
  server-side queue; closing the popup does not stop the download)
- Real-time download progress (SSE)
- List of parallel downloads with cancel buttons in the popup and an active-
  job counter on the extension icon
- Server URL and folder path configuration with a connection test

## Requirements

- Chrome 88 or newer (Manifest V3)
- The video-search-app server must be running
- The folder path must be in the server's `VIDEOS_FOLDER_PATH`
- The server must be reachable from the browser (CORS configured)

## Development

- Source code: `src/*.ts` (TypeScript, strict, the same strict flags as the
  rest of the repo). Pure logic (SSE framing, progress extraction, YouTube id
  detection) lives in `src/lib/` with unit tests (Vitest): `npm test`.
- The SSE event contract (`DownloadVideoEvent`) and the yt-dlp progress parser
  come from `shared/` (`api.ts`, types via `import type`; `progress.ts`, real
  logic, bundled by esbuild).
- `npm run typecheck` checks the types, `npm run build` generates
  `background.js`, `content.js`, `popup.js` and `options.js` (generated files
  are not committed). From the repo root, `npm run build:extension`,
  `npm run typecheck` and `npm test` also work (they cover all packages).

## Icons

Place icons in the `icons/` folder:

- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

You can use placeholder icons or create your own.
