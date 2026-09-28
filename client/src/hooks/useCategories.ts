import { CategoriesResponseSchema } from '@videodeck/shared/schemas';
import { useEffect, useState } from 'react';
import { apiGet } from '../utils/apiClient';
import { useLibraryReadKey } from './useLibrary';

interface UseCategoriesResult {
  categories: string[];
}

/**
 * Categories declared in the folders' config.json, for the search filter.
 * A failure here only leaves the filter empty — search itself still works.
 * The fetch is aborted on unmount so a navigated-away page does not keep the
 * request alive.
 */
export function useCategories(): UseCategoriesResult {
  const [categories, setCategories] = useState<string[]>([]);
  // Categories live in the folders' config.json, so a drive that arrives can
  // bring new ones: the filter follows the library revision.
  const readKey = useLibraryReadKey();
  useEffect(() => {
    if (readKey === null) {
      return;
    }
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const data = await apiGet('/api/videos/categories', CategoriesResponseSchema, {
          signal: controller.signal,
          message: (status) => `HTTP error! status: ${status}`,
        });
        setCategories(data.categories || []);
      } catch {
        if (controller.signal.aborted) {
          return; // unmounted — nothing to report
        }
        // The filter simply stays empty; search itself still works
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, [readKey]);

  return { categories };
}
