export interface FolderConfig {
  channelUrl?: string;
}

export interface StatusData {
  videosFolderPath: string[];
  folderConfigs: Record<string, FolderConfig | null>;
  status: string;
}

export interface StatusState {
  statusData: StatusData | null;
  loading: boolean;
  error: string | null;
}

export enum StatusActionType {
  FETCH_START = 'FETCH_START',
  FETCH_SUCCESS = 'FETCH_SUCCESS',
  FETCH_ERROR = 'FETCH_ERROR',
  RESET = 'RESET',
}

export type StatusAction =
  | { type: StatusActionType.FETCH_START }
  | { type: StatusActionType.FETCH_SUCCESS; payload: StatusData }
  | { type: StatusActionType.FETCH_ERROR; payload: string }
  | { type: StatusActionType.RESET };

export const initialState: StatusState = {
  statusData: null,
  loading: true,
  error: null,
};

export function statusReducer(
  state: StatusState,
  action: StatusAction
): StatusState {
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

