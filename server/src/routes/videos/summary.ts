import type { VideoSummaryResponse } from '@videodeck/shared/api';
import { generateSummary, SummaryUnavailableError } from '../../services/summaryService';
import { stripUndefined } from '../../utils/objectUtils';
import type { RouteHandler } from '../http';
import { findVideo } from './helpers';

/**
 * GET /api/videos/:identifier/summary.
 *
 * Cached summaries, VTT cleaning, the OpenAI fallback and the disk cache all
 * live in the summary service; this handler only resolves the video and turns
 * the service's failures into responses.
 */

// GET /api/videos/:identifier/summary - supports both baseName and videoId
export const getSummary: RouteHandler<{ identifier: string }, VideoSummaryResponse> = async (req, res) => {
  const video = await findVideo(req.params.identifier);

  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  if (!video.subtitlePath) {
    res.status(404).json({ error: 'Subtitle not found' });
    return;
  }

  // Cached summaries, VTT cleaning, OpenAI fallback and disk caching live in
  // the service; failures bubble up to the error handler middleware — except
  // the "no key configured" case, which gets a distinct, actionable 503.
  let summary: string;
  let truncated: boolean;
  try {
    ({ summary, truncated } = await generateSummary({
      folderPath: video.folderPath,
      baseName: video.baseName,
      subtitlePath: video.subtitlePath,
    }));
  } catch (error) {
    if (error instanceof SummaryUnavailableError) {
      res.status(503).json({ error: 'Summaries are disabled — set OPENAI_API_KEY on the server' });
      return;
    }
    throw error;
  }

  // `truncated` is only present when true
  res.json(stripUndefined<VideoSummaryResponse>({ summary, truncated: truncated ? true : undefined }));
};
