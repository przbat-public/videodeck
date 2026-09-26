import type { CategoriesResponse, ChannelsResponse, SearchResponse } from '@videodeck/shared/api';
import type { SearchOptions } from '../../services/elasticsearchService';
import { listChannelNames, SEARCH_DEFAULT_LIMIT } from '../../services/elasticsearchService';
import { getFolderPathsForCategory, listCategories } from '../../services/folderConfig';
import { getVideos } from '../../services/videoScanner';
import { stripUndefined } from '../../utils/objectUtils';
import type { NoParams, RouteHandler } from '../http';
import { readString } from '../http';
import { parseNonNegativeInt, parseOffset, parseSortOption } from './helpers';

/**
 * The search endpoint and the two facet lists the search UI filters by.
 *
 * Categories come from the folder config service, which caches them for a few
 * seconds and drops that cache on a config write; channel names come from
 * Elasticsearch. Both are read per request, so no copy lives here.
 */

// GET /api/videos/search?q={query}&sort={sortOption}&category={category}&offset=&limit=
// The category is read from each folder's config.json and narrows the search
// to that category's folders; an unknown category matches no folder at all.
export const search: RouteHandler<NoParams, SearchResponse> = async (req, res) => {
  const query = readString(req.query.q);
  const sort = parseSortOption(req.query.sort);
  const category = readString(req.query.category)?.trim();
  const offset = parseOffset(readString(req.query.offset));
  const limit = parseNonNegativeInt(readString(req.query.limit), SEARCH_DEFAULT_LIMIT);
  const channel = readString(req.query.channel)?.trim() || undefined;

  const folderPaths = category ? await getFolderPathsForCategory(category) : undefined;

  const options = stripUndefined<SearchOptions>({ offset, limit, channel });
  const { videos, total: totalCount } = await getVideos(query, sort, folderPaths, options);

  res.json({ videos, totalCount });
};

// GET /api/videos/categories
export const getCategories: RouteHandler<NoParams, CategoriesResponse> = async (_req, res) => {
  res.json({ categories: await listCategories() });
};

// GET /api/videos/channels - distinct channel names for the filter UI, plus
// the channel of every folder for the console's search link
export const getChannelNames: RouteHandler<NoParams, ChannelsResponse> = async (_req, res) => {
  res.json(await listChannelNames());
};
