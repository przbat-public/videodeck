import { useCallback } from 'react';

/**
 * Focus target for a page's `<main>` landmark (pair it with `tabIndex={-1}`).
 *
 * A client-side route change unmounts whatever held focus, so the browser
 * drops focus back to `<body>`: a keyboard or screen reader user lands at the
 * top of the document with no announcement that the page changed. Moving focus
 * to the new page's main landmark fixes that, and it stays out of the way when
 * something inside the page already holds focus (an autofocused field, a
 * dialog), because then the browser did not drop it to the body.
 *
 * This is a callback ref rather than a mount effect on purpose: a route error
 * makes React replace the landmark with the error element's own one, and a
 * mount effect would not run again for that new node, leaving focus on the
 * body.
 */
export function usePageFocus<T extends HTMLElement>(): (node: T | null) => void {
  return useCallback((node: T | null) => {
    if (node === null) {
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body) {
      return;
    }
    node.focus();
  }, []);
}
