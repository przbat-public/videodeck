import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * One shared mock for react-hot-toast, registered once in test/setup.ts.
 * Six test files used to carry their own copies of this factory; a single
 * instance keeps the assertions uniform and the reset in setup's beforeEach
 * predictable.
 */
export interface ToastMock {
  success: Mock;
  error: Mock;
  loading: Mock;
}

export const toast: ToastMock = {
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => 'toast-id'),
};
