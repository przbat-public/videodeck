export interface VideoDownloadState {
  isDownloading: boolean;
  downloadOutput: string[];
  downloadError: string | null;
}

export enum VideoDownloadActionType {
  START_DOWNLOAD = 'START_DOWNLOAD',
  ADD_OUTPUT = 'ADD_OUTPUT',
  SET_ERROR = 'SET_ERROR',
  COMPLETE_DOWNLOAD = 'COMPLETE_DOWNLOAD',
}

export type VideoDownloadAction =
  | { type: VideoDownloadActionType.START_DOWNLOAD }
  | { type: VideoDownloadActionType.ADD_OUTPUT; payload: string }
  | { type: VideoDownloadActionType.SET_ERROR; payload: string }
  | { type: VideoDownloadActionType.COMPLETE_DOWNLOAD };

export const initialDownloadState: VideoDownloadState = {
  isDownloading: false,
  downloadOutput: [],
  downloadError: null,
};

export function videoDownloadReducer(
  state: VideoDownloadState,
  action: VideoDownloadAction
): VideoDownloadState {
  switch (action.type) {
    case VideoDownloadActionType.START_DOWNLOAD:
      return {
        isDownloading: true,
        downloadOutput: [],
        downloadError: null,
      };
    case VideoDownloadActionType.ADD_OUTPUT:
      return {
        ...state,
        downloadOutput: [...state.downloadOutput, action.payload],
      };
    case VideoDownloadActionType.SET_ERROR:
      return {
        ...state,
        downloadError: action.payload,
        isDownloading: false,
      };
    case VideoDownloadActionType.COMPLETE_DOWNLOAD:
      return {
        ...state,
        isDownloading: false,
      };
    default:
      return state;
  }
}

