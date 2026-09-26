import type { ApiError } from '@videodeck/shared/api';
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
