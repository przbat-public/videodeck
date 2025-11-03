import { useReducer, useCallback } from 'react';
import toast from 'react-hot-toast';

import {
  cacheRefreshReducer,
  initialState,
  CacheRefreshActionType,
} from '../reducers/cacheRefreshReducer';

interface UseCacheRefreshResult {
  loading: boolean;
  refreshCache: () => Promise<void>;
}

export function useCacheRefresh(): UseCacheRefreshResult {
  const [state, dispatch] = useReducer(cacheRefreshReducer, initialState);

  const refreshCache = useCallback(async (): Promise<void> => {
    dispatch({ type: CacheRefreshActionType.REFRESH_START });

    try {
      const response = await fetch('/api/videos/refreshCache');
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      dispatch({ type: CacheRefreshActionType.REFRESH_SUCCESS, payload: '' });

      toast.success(data.message || 'Cache refresh process started successfully!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start cache refresh';
      dispatch({
        type: CacheRefreshActionType.REFRESH_ERROR,
        payload: errorMessage,
      });

      toast.error(errorMessage);
    }
  }, []);

  return {
    loading: state.loading,
    refreshCache,
  };
}

