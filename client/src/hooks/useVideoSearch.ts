import { useState, useEffect } from 'react';
import queryString from 'query-string';
import { VideoListItem } from '../types';

interface UseVideoSearchResult {
  videos: VideoListItem[];
  loading: boolean;
  error: string | null;
  search: (query?: string) => Promise<void>;
}

export function useVideoSearch(): UseVideoSearchResult {
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const trimmedQuery = query?.trim();

      const url = queryString.stringifyUrl(
        { url: '/api/videos/search', query: { q: trimmedQuery } },
        { skipEmptyString: true, skipNull: true }
      );
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to search videos');
      }
      const data = await response.json();
      setVideos(data.videos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setVideos([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    search();
  }, []);

  return { videos, loading, error, search };
}
