import type { FolderConfig } from '@shared/api';
import { StatusResponseSchema } from '@shared/schemas';
import { useEffect, useReducer } from 'react';
import i18n from '../i18n';
import type { StatusData } from '../reducers/statusReducer';
import { initialState, StatusActionType, statusReducer } from '../reducers/statusReducer';

interface UseStatusResult {
  state: { statusData: StatusData | null; loading: boolean; error: string | null };
  /** Merge a freshly saved folder config into the loaded status */
  updateFolderConfig: (folderPath: string, config: FolderConfig | null) => void;
}

/**
 * GET /api/status state for the StatusPage, with the same pattern as the
 * other data hooks: a reducer plus one fetch effect (aborted on unmount).
 */
export function useStatus(): UseStatusResult {
  const [state, dispatch] = useReducer(statusReducer, initialState);

  useEffect(() => {
    const controller = new AbortController();

    const fetchStatus = async (): Promise<void> => {
      try {
        dispatch({ type: StatusActionType.FETCH_START });
        const response = await fetch('/api/status', { signal: controller.signal });
        if (!response.ok) {
          throw new Error(i18n.t('errors.fetchStatus'));
        }
        const data = StatusResponseSchema.parse(await response.json()) as StatusData;
        dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: data });
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        const errorMessage = err instanceof Error ? err.message : i18n.t('errors.occurred');
        dispatch({ type: StatusActionType.FETCH_ERROR, payload: errorMessage });
      }
    };

    void fetchStatus();
    return () => {
      controller.abort();
    };
  }, []);

  const updateFolderConfig = (folderPath: string, config: FolderConfig | null): void => {
    if (state.statusData) {
      const updatedStatusData: StatusData = {
        ...state.statusData,
        folderConfigs: {
          ...state.statusData.folderConfigs,
          [folderPath]: config,
        },
      };
      dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: updatedStatusData });
    }
  };

  return { state, updateFolderConfig };
}
