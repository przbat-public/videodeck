import type { FolderConfig } from '@videodeck/shared/api';
import { StatusResponseSchema } from '@videodeck/shared/schemas';
import { useCallback, useEffect, useReducer } from 'react';
import i18n from '../i18n';
import type { StatusData } from '../reducers/statusReducer';
import { initialState, StatusActionType, statusReducer } from '../reducers/statusReducer';
import { apiGet } from '../utils/apiClient';
import { reportElasticsearchReachable, reportElasticsearchUnavailable } from '../utils/elasticsearchStatus';

interface UseStatusResult {
  state: { statusData: StatusData | null; loading: boolean; error: string | null };
  /** Merge a freshly saved folder config into the loaded status */
  updateFolderConfig: (folderPath: string, config: FolderConfig | null) => void;
  /** Ask for the status again after a failed load (the retry button) */
  reload: () => void;
}

/**
 * GET /api/status state for the StatusPage, with the same pattern as the
 * other data hooks: a reducer plus one fetch effect (aborted on unmount).
 * The same loader backs `reload`, so a failed load has a way back that does
 * not need a full page refresh.
 */
export function useStatus(): UseStatusResult {
  const [state, dispatch] = useReducer(statusReducer, initialState);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      dispatch({ type: StatusActionType.FETCH_START });
      const data = await apiGet('/api/status', StatusResponseSchema, {
        ...(signal ? { signal } : {}),
        message: i18n.t('errors.fetchStatus'),
      });
      if (signal?.aborted) {
        // Unmounted while the (large) answer was on its way: a page the reader
        // has left must not move the app-wide banner. The abort guard in the
        // catch below covers the failed read; this covers the successful one,
        // whose body can resolve after the unmount too.
        return;
      }
      // The status answer says whether the index read worked, so the banner
      // knows before the first /health poll comes back. A healthy read is only
      // evidence: it must not clear a state the probe reported.
      if (data.elasticsearch === 'down') {
        reportElasticsearchUnavailable();
      } else {
        reportElasticsearchReachable();
      }
      dispatch({ type: StatusActionType.FETCH_SUCCESS, payload: data });
    } catch (err) {
      if (signal?.aborted) {
        return; // unmounted: nothing to report
      }
      const errorMessage = err instanceof Error ? err.message : i18n.t('errors.occurred');
      dispatch({ type: StatusActionType.FETCH_ERROR, payload: errorMessage });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const reload = useCallback((): void => {
    void load();
  }, [load]);

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

  return { state, updateFolderConfig, reload };
}
