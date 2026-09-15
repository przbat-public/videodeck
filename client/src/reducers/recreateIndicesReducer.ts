export interface RecreateIndicesState {
  loading: boolean;
  message: { type: 'success' | 'error'; text: string } | null;
}

export const RecreateIndicesActionType = {
  RECREATE_START: 'RECREATE_START',
  RECREATE_SUCCESS: 'RECREATE_SUCCESS',
  RECREATE_ERROR: 'RECREATE_ERROR',
  CLEAR_MESSAGE: 'CLEAR_MESSAGE',
} as const;
export type RecreateIndicesActionType = (typeof RecreateIndicesActionType)[keyof typeof RecreateIndicesActionType];

export type RecreateIndicesAction =
  | { type: 'RECREATE_START' }
  | { type: 'RECREATE_SUCCESS'; payload: string }
  | { type: 'RECREATE_ERROR'; payload: string }
  | { type: 'CLEAR_MESSAGE' };

export const initialState: RecreateIndicesState = {
  loading: false,
  message: null,
};

export function recreateIndicesReducer(
  state: RecreateIndicesState,
  action: RecreateIndicesAction,
): RecreateIndicesState {
  switch (action.type) {
    case RecreateIndicesActionType.RECREATE_START:
      return {
        ...state,
        loading: true,
        message: null,
      };
    case RecreateIndicesActionType.RECREATE_SUCCESS:
      return {
        ...state,
        loading: false,
        message: { type: 'success', text: action.payload },
      };
    case RecreateIndicesActionType.RECREATE_ERROR:
      return {
        ...state,
        loading: false,
        message: { type: 'error', text: action.payload },
      };
    case RecreateIndicesActionType.CLEAR_MESSAGE:
      return {
        ...state,
        message: null,
      };
    default:
      return state;
  }
}
