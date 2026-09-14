import { useReducer, useCallback } from 'react';
import toast from 'react-hot-toast';
import i18n from '../i18n';

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
    const loadingToastId = toast.loading(i18n.t('toast.recreateStarting'));

    try {
      const response = await fetch('/api/videos/recreateIndices', {
        method: 'POST',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }

      await response.json();
      dispatch({ type: RecreateIndicesActionType.RECREATE_SUCCESS, payload: '' });

      toast.success(i18n.t('toast.recreateDone'), { id: loadingToastId });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : i18n.t('errors.recreateStart');
      dispatch({
        type: RecreateIndicesActionType.RECREATE_ERROR,
        payload: errorMessage,
      });

      toast.error(errorMessage, { id: loadingToastId });
    }
  }, []);

  return {
    loading: state.loading,
    recreateIndices,
  };
}
