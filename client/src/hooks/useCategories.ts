import { useEffect, useState } from 'react';
import type { CategoriesResponse } from '@shared/api';

interface UseCategoriesResult {
  categories: string[];
}

/**
 * Categories declared in the folders' config.json, for the search filter.
 * A failure here only leaves the filter empty, so it is logged rather than
 * surfaced as a toast — search itself still works.
 */
export function useCategories(): UseCategoriesResult {
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      try {
        const response = await fetch('/api/videos/categories');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data: CategoriesResponse = await response.json();
        if (active) {
          setCategories(data.categories || []);
        }
      } catch (err) {
        console.error('Failed to load categories:', err);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  return { categories };
}
