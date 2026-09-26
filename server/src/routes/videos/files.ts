import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApiError } from '@videodeck/shared/api';
import type { Response } from 'express';
import { getVideosFolderPaths } from '../../config';
import { getVideoByFilePath } from '../../services/elasticsearchService';
import { logger } from '../../utils/logger';
import { getVideoFilePath, normalizeFolderPath } from '../../utils/videoPathUtils';
import { stripVttCueSettings } from '../../utils/vttUtils';
import type { RouteHandler } from '../http';

/**
 * GET /api/videos/file/:filename: the only endpoint that reads video bytes.
 *
 * Three layers guard the read, in this order: the folder allowlist (from
 * `?folder=` or from the Elasticsearch lookup), a lexical containment check on
 * the resolved path, and a realpath containment check that also covers a
 * symlink planted inside the folder. Every read below uses the realpath, so no
 * access-then-send window opens up.
 *
 * VTT files are the exception to the caching rules: they are rewritten in
 * place on metadata updates, so they are served `no-cache` and with the cue
 * settings stripped.
 */

/** Content type and cache headers for a served file extension */
function fileContentType(ext: string): { contentType: string; immutable: boolean } {
  if (ext === '.mp4') {
    return { contentType: 'video/mp4', immutable: true };
  }
  if (ext === '.webp') {
    return { contentType: 'image/webp', immutable: true };
  }
  if (ext === '.vtt') {
    return { contentType: 'text/vtt; charset=utf-8', immutable: false };
  }
  return { contentType: 'application/octet-stream', immutable: false };
}

/**
 * Resolve the folder a file must be served from. With `?folder=` it has to be
 * one of the configured folders; without it the file name is looked up in
 * Elasticsearch. Sends the proper error response and returns undefined when
 * the folder cannot be determined.
 */
async function resolveServeFolder<Res>(
  filename: string,
  folderParam: unknown,
  res: Response<Res | ApiError>,
): Promise<string | undefined> {
  if (folderParam !== undefined) {
    const normalized = typeof folderParam === 'string' ? normalizeFolderPath(folderParam) : undefined;
    if (
      normalized === undefined ||
      !getVideosFolderPaths().some((allowed) => normalizeFolderPath(allowed) === normalized)
    ) {
      res.status(403).json({ error: `Folder path is not in the allowed list: ${String(folderParam)}` });
      return undefined;
    }
    return normalized;
  }
  try {
    const video = await getVideoByFilePath(filename);
    if (video?.folderPath !== undefined) {
      return video.folderPath;
    }
  } catch (lookupError) {
    logger.error('Error looking up file in Elasticsearch:', lookupError);
  }
  // A file that is not indexed cannot be served — never fall back to a
  // guessed folder (that used to leak files from the first configured one).
  res.status(404).json({ error: 'File not found' });
  return undefined;
}

// GET /api/videos/file/:filename?folder=<folderPath>
// The folder is taken from the `folder` query param (must be one of the
// configured folders); without it we look the file name up in Elasticsearch.
export const serveFile: RouteHandler<{ filename: string }, never> = async (req, res) => {
  const { filename } = req.params;
  const folderPath = await resolveServeFolder(filename, req.query.folder, res);
  if (folderPath === undefined) {
    return;
  }
  // Final allowlist assertion next to the file sinks: the guard must live on
  // the same code path as the reads so authorization cannot drift from use
  // (the Elasticsearch-lookup branch is re-checked here too).
  const normalizedFolder = normalizeFolderPath(folderPath);
  const allowedFolders = getVideosFolderPaths().map(normalizeFolderPath);
  if (!allowedFolders.includes(normalizedFolder)) {
    res.status(403).json({ error: `Folder path is not in the allowed list: ${folderPath}` });
    return;
  }

  // Containment check next to the file sinks: resolve the request to an
  // absolute path and verify it stays inside the allowed folder, so a
  // filename can never escape the folder even if the sanitizer missed a
  // traversal. getVideoFilePath already rejects `..` segments — this is the
  // defense-in-depth layer the reads below depend on.
  const filePath = path.resolve(getVideoFilePath(filename, folderPath));
  const folderRoot = `${normalizedFolder}${path.sep}`;
  if (!filePath.startsWith(folderRoot)) {
    res.status(403).json({ error: 'File is outside the video folder' });
    return;
  }

  // Resolve symlinks and re-check containment: a symlink planted inside the
  // folder must not make the server read or serve files outside it. The
  // resolved path is used for every read below (no access→sendFile TOCTOU).
  let realPath: string;
  try {
    const [realFile, realFolder] = await Promise.all([fs.realpath(filePath), fs.realpath(normalizedFolder)]);
    const realRoot = realFolder.endsWith(path.sep) ? realFolder : `${realFolder}${path.sep}`;
    if (!realFile.startsWith(realRoot)) {
      res.status(403).json({ error: 'File is outside the video folder' });
      return;
    }
    realPath = realFile;
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const ext = path.extname(filename).toLowerCase();

  if (ext === '.vtt') {
    // yt-dlp auto captions carry `align:start position:0%` on every cue,
    // pinning the text to the left edge — strip the settings so the browser
    // centers the cues the way it does for plain WebVTT. Subtitles are
    // re-downloaded in place on metadata updates — always revalidate, never
    // serve a stale cue file.
    try {
      const vtt = await fs.readFile(realPath, 'utf-8');
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(stripVttCueSettings(vtt));
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
    return;
  }

  const { contentType, immutable } = fileContentType(ext);
  res.setHeader('Content-Type', contentType);
  if (immutable) {
    // Videos and thumbnails are content-addressed by their yt-dlp file stem:
    // a new version gets a new name, so the same URL always serves the same
    // bytes.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  res.sendFile(realPath);
};
