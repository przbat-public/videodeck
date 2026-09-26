import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChannelVideo, FolderListResponse, ListExistsResponse, RebuildIndexResponse } from '@videodeck/shared/api';
import { ListJsonError, readListJson } from '../../services/channelList';
import { readCollection } from '../../services/collection';
import { readFolderConfig } from '../../services/folderConfig';
import { getDownloadStatuses, rebuildIndex } from '../../services/folderIndex';
import { logger } from '../../utils/logger';
import type { NoParams, RouteHandler } from '../http';
import { errnoCode, readBody } from '../http';
import { requireAllowedFolder } from './guards';

/**
 * The list.json reads and the index rebuild.
 *
 * All three handlers read one authorized folder from disk: the list.json
 * presence probe, the video list with its download statuses (a collection
 * serves its index instead) and the explicit rebuild of that index. Nothing
 * here is cached, so every call sees the folder as it is now.
 */

export const listExists: RouteHandler<NoParams, ListExistsResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(req.query.folderPath, res);
  if (!folderPath) return;

  try {
    await fs.access(path.join(folderPath, 'list.json'));
    res.json({ exists: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      res.json({ exists: false });
      return;
    }
    throw error;
  }
};

/**
 * list.json content plus download statuses. Statuses come from the folder
 * index (`.videos-index.json`) instead of parsing every info.json. A
 * collection has no list.json, so its list is the index itself.
 */
export const getFolderList: RouteHandler<NoParams, FolderListResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(req.query.folderPath, res);
  if (!folderPath) return;

  if ((await readFolderConfig(folderPath))?.kind === 'collection') {
    res.json(await readCollection(folderPath));
    return;
  }

  let videos: ChannelVideo[] | null;
  try {
    videos = await readListJson(folderPath);
  } catch (error) {
    if (error instanceof ListJsonError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!videos) {
    res.status(404).json({ error: 'list.json not found' });
    return;
  }

  let downloadStatuses: Record<string, boolean> = {};
  let lastUpdatedDates: Record<string, string> = {};
  try {
    ({ downloadStatuses, lastUpdatedDates } = await getDownloadStatuses(folderPath));
  } catch (error) {
    // Folder unreadable — treat everything as not downloaded
    logger.error(`Error loading folder index for ${folderPath}:`, error);
  }

  res.json({ videos, downloadStatuses, lastUpdatedDates });
};

export const rebuildFolderIndex: RouteHandler<NoParams, RebuildIndexResponse> = async (req, res) => {
  const folderPath = requireAllowedFolder(readBody(req).folderPath, res);
  if (!folderPath) return;

  const index = await rebuildIndex(folderPath);
  res.json({ success: true, count: Object.keys(index.entries).length, builtAt: index.builtAt });
};
