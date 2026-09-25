import type { DefaultToastOptions } from 'react-hot-toast';

/**
 * The toast surface, as react-hot-toast wants it: options, not CSS. Every
 * colour is a design token from client/src/index.css, so the toast follows
 * DESIGN.md and keeps its parity in dark mode. The semantic icon colours
 * reuse the tokens the rest of the UI uses; the background and the text are
 * the toast's own tokens because it is a floating surface, not a page one.
 *
 * The options live here, out of App.tsx, so a test can hold them to the
 * stylesheet (utils/toastOptions.test.ts).
 */
export const TOAST_OPTIONS: DefaultToastOptions = {
  duration: 10000,
  style: {
    background: 'var(--color-toast-bg)',
    color: 'var(--color-toast-text)',
  },
  success: {
    duration: 10000,
    iconTheme: {
      primary: 'var(--color-success)',
      secondary: 'var(--color-toast-text)',
    },
  },
  error: {
    duration: 10000,
    iconTheme: {
      primary: 'var(--color-danger)',
      secondary: 'var(--color-toast-text)',
    },
  },
};
