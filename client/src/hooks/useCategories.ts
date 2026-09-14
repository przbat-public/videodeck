import { useEffect, useState } from 'react';
import type { CategoriesResponse } from '@shared/api';

interface UseCategoriesResult {
  categories: string[];
}

/**
 * Categories declared in the folders' config.json, for the search filter.
 * A failure here only leaves the filter empty, so it is logged rather than
 * surfaced as a toast — search itself still works. The fetch is aborted on
 * unmount so a navigated-away page does not keep the request alive.
 */
export function useCategories(): UseCategoriesResult {
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/videos/categories', { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data: CategoriesResponse = await response.json();
        setCategories(data.categories || []);
      } catch (err) {
        if (controller.signal.aborted) {
          return; // unmounted — nothing to report
        }
        console.error('Failed to load categories:', err);
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, []);

  return { categories };
}
