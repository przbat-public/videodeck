import fs from 'node:fs/promises';
import type { ApiError } from '@videodeck/shared/api';
import { FOLDER_UNAVAILABLE_CODE } from '@videodeck/shared/schemas';
import type { Response } from 'express';
import { getVideosFolderPaths } from '../../config';
import { logger } from '../../utils/logger';
import { normalizeFolderPath } from '../../utils/videoPathUtils';
import { readString } from '../http';

/**
 * The folder allowlist check every folder handler authorizes through.
 *
 * The guard answers on the response itself and reports back with null, so all
 * callers keep the same 400/403 bodies and the same order: authorization
 * before a request body is parsed. Keeping the comparison in one module
 * matters because CodeQL treats it as the sanitizer for the file sinks further
 * down the request path.
 */

/**
 * Resolve and authorize a folder path coming from the request.
 * `~/` and trailing slashes are normalized before the comparison, so a
 * hand-typed extension option matches the configured list. Sends the proper
 * error response (echoing the received value) and returns null when invalid.
 */
export function requireAllowedFolder<Res>(value: unknown, res: Response<Res | ApiError>): string | null {
  const folderPath = readString(value);
  if (folderPath === undefined) {
    res.status(400).json({ error: 'folderPath is required' });
    return null;
  }
  const normalized = normalizeFolderPath(folderPath);
  const allowed = getVideosFolderPaths().find((candidate) => normalizeFolderPath(candidate) === normalized);
  if (allowed === undefined) {
    logger.warn(`Rejected folderPath not in the allowed list: ${folderPath}`);
    res.status(403).json({ error: `Folder path is not in the allowed list: ${folderPath}` });
    return null;
  }
  // Hand back the configured entry, not the request value. The two strings
  // are equal by the comparison above, but only the configured one is
  // provably free of user input, which is what lets taint analysis (CodeQL
  // js/path-injection) treat this check as the sanitizer it is.
  return normalizeFolderPath(allowed);
}

/**
 * The folder has to be a directory right now, before anything is created in
 * it. A literal root stays in the allowlist while its volume is away, so
 * without this check a request either answered a generic 500 (EACCES) or,
 * worse, `mkdir -p` created a real directory on the internal disk and yt-dlp
 * downloaded there instead of onto the drive.
 *
 * Answers 409 with a machine-readable code and reports back false, the way
 * `requireAllowedFolder` does.
 */
export async function requireMountedFolder<Res>(folderPath: string, res: Response<Res | ApiError>): Promise<boolean> {
  try {
    if ((await fs.stat(folderPath)).isDirectory()) {
      return true;
    }
  } catch {
    // Reported below: ENOENT, ENOTDIR and a permission error all mean the same
    // thing to the caller, which is that nothing may be written here.
  }
  logger.warn(`Refused folder that is not mounted: ${folderPath}`);
  res.status(409).json({
    error: 'Folder is not available',
    message: `The drive for ${folderPath} is not mounted right now, or the folder is gone`,
    code: FOLDER_UNAVAILABLE_CODE,
  });
  return false;
}
