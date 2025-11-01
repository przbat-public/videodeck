import { useState, useEffect } from 'react';

export interface VideoInfo {
  baseName: string;
  name: string;
  description: string;
  videoPath: string;
  thumbnailPath: string;
  uploadDate?: string; // YYYYMMDD format from filename
}

interface UseVideoSearchResult {
  videos: VideoInfo[];
  loading: boolean;
  error: string | null;
  search: (query: string) => Promise<void>;
  loadAll: () => Promise<void>;
}

export function useVideoSearch(): UseVideoSearchResult {
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) {
        params.append('q', query.trim());
      }
      const response = await fetch(`/api/videos/search?${params.toString()}`);
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

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/videos/list');
      if (!response.ok) {
        throw new Error('Failed to load videos');
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
    loadAll();
  }, []);

  return { videos, loading, error, search, loadAll };
}
