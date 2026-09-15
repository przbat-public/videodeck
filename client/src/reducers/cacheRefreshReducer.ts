export interface CacheRefreshState {
  loading: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
}

export const CacheRefreshActionType = {
  REFRESH_START: 'REFRESH_START',
  REFRESH_SUCCESS: 'REFRESH_SUCCESS',
  REFRESH_ERROR: 'REFRESH_ERROR',
  CLEAR_MESSAGE: 'CLEAR_MESSAGE',
} as const;
export type CacheRefreshActionType = (typeof CacheRefreshActionType)[keyof typeof CacheRefreshActionType];

export type CacheRefreshAction =
  | { type: 'REFRESH_START' }
  | { type: 'REFRESH_SUCCESS'; payload: string }
  | { type: 'REFRESH_ERROR'; payload: string }
  | { type: 'CLEAR_MESSAGE' };

export const initialState: CacheRefreshState = {
  loading: false,
  message: null,
};

export function cacheRefreshReducer(state: CacheRefreshState, action: CacheRefreshAction): CacheRefreshState {
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
