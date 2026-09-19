import { render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { usePageFocus } from './usePageFocus';

/** A page-level landmark wired up the way the real pages wire it */
function Page({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = usePageFocus<HTMLElement>();
  return (
    <main ref={ref} tabIndex={-1} data-testid="main">
      {children}
    </main>
  );
}

/** Focuses itself during the commit, like an autofocused field would */
function AutoFocusedField(): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <button ref={ref} type="button">
      akcja
    </button>
  );
}

describe('usePageFocus', () => {
  it('moves focus to the landmark when a route change dropped it to the body', () => {
    render(<Page />);

    expect(document.activeElement).toBe(screen.getByTestId('main'));
  });

  it('leaves focus alone when something on the page already holds it', () => {
    render(
      <Page>
        <AutoFocusedField />
      </Page>,
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'akcja' }));
  });
});
