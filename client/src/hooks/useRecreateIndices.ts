import { useReducer, useCallback } from 'react';
import toast from 'react-hot-toast';

import {
  recreateIndicesReducer,
  initialState,
  RecreateIndicesActionType,
} from '../reducers/recreateIndicesReducer';

interface UseRecreateIndicesResult {
  loading: boolean;
  recreateIndices: () => Promise<void>;
}

export function useRecreateIndices(): UseRecreateIndicesResult {
  const [state, dispatch] = useReducer(recreateIndicesReducer, initialState);

  const recreateIndices = useCallback(async (): Promise<void> => {
    dispatch({ type: RecreateIndicesActionType.RECREATE_START });

    try {
      const response = await fetch('/api/videos/recreateIndices', {
        method: 'POST',
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      dispatch({ type: RecreateIndicesActionType.RECREATE_SUCCESS, payload: '' });

      toast.success(data.message || 'Indices recreation process started successfully!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start indices recreation';
      dispatch({
        type: RecreateIndicesActionType.RECREATE_ERROR,
        payload: errorMessage,
      });

      toast.error(errorMessage);
    }
  }, []);

  return {
    loading: state.loading,
    recreateIndices,
  };
}

