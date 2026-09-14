import type { StatusResponse } from '@shared/api';

/** GET /api/status payload as kept in the reducer */
export type StatusData = StatusResponse;

export interface StatusState {
  statusData: StatusData | null;
  loading: boolean;
  error: string | null;
}

export const StatusActionType = {
  FETCH_START: 'FETCH_START',
  FETCH_SUCCESS: 'FETCH_SUCCESS',
  FETCH_ERROR: 'FETCH_ERROR',
  RESET: 'RESET',
} as const;
export type StatusActionType = (typeof StatusActionType)[keyof typeof StatusActionType];

export type StatusAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; payload: StatusData }
  | { type: 'FETCH_ERROR'; payload: string }
  | { type: 'RESET' };

export const initialState: StatusState = {
  statusData: null,
  loading: true,
  error: null,
};

export function statusReducer(state: StatusState, action: StatusAction): StatusState {
  switch (action.type) {
    case StatusActionType.FETCH_START:
      return {
        ...state,
        loading: true,
        error: null,
      };
    case StatusActionType.FETCH_SUCCESS:
      return {
        ...state,
        statusData: action.payload,
        loading: false,
        error: null,
      };
    case StatusActionType.FETCH_ERROR:
      return {
        ...state,
        error: action.payload,
        loading: false,
      };
    case StatusActionType.RESET:
      return initialState;
    default:
      return state;
  }
}
