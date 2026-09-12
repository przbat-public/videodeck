export interface CacheRefreshState {
  loading: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
}

export enum CacheRefreshActionType {
  REFRESH_START = 'REFRESH_START',
  REFRESH_SUCCESS = 'REFRESH_SUCCESS',
  REFRESH_ERROR = 'REFRESH_ERROR',
  CLEAR_MESSAGE = 'CLEAR_MESSAGE',
}

export type CacheRefreshAction =
  | { type: CacheRefreshActionType.REFRESH_START }
  | { type: CacheRefreshActionType.REFRESH_SUCCESS; payload: string }
  | { type: CacheRefreshActionType.REFRESH_ERROR; payload: string }
  | { type: CacheRefreshActionType.CLEAR_MESSAGE };

export const initialState: CacheRefreshState = {
  loading: false,
  message: null,
};

export function cacheRefreshReducer(
  state: CacheRefreshState,
  action: CacheRefreshAction
): CacheRefreshState {
  switch (action.type) {
    case CacheRefreshActionType.REFRESH_START:
      return {
        ...state,
        loading: true,
        message: null,
      };
    case CacheRefreshActionType.REFRESH_SUCCESS:
      return {
        ...state,
        loading: false,
        message: { type: 'success', text: action.payload },
      };
    case CacheRefreshActionType.REFRESH_ERROR:
      return {
        ...state,
        loading: false,
        message: { type: 'error', text: action.payload },
      };
    case CacheRefreshActionType.CLEAR_MESSAGE:
      return {
        ...state,
        message: null,
      };
    default:
      return state;
  }
}
