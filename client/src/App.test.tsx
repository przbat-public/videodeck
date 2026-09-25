import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';

const renderShell = () => {
  const router = createMemoryRouter([{ path: '/', element: <h1>Testowa strona</h1> }], {
    initialEntries: ['/'],
  });
  render(<App router={router} />);
  return router;
};

describe('App', () => {
  afterEach(() => {
    // jsdom does not model history.scrollRestoration, so the effect leaves an
    // own property behind; drop it instead of leaking it into the next test.
    Reflect.deleteProperty(window.history, 'scrollRestoration');
  });

  it('renders the shell and the routed page inside it', () => {
    renderShell();

    expect(screen.getByRole('heading', { name: 'Testowa strona' })).toBeInTheDocument();
  });

  it('turns off the browser scroll restoration the app replaces', () => {
    renderShell();

    // The result list restores its own offset once the pages are back
    // (hooks/useListScrollRestoration); the browser's attempt runs earlier,
    // against a document that is still short, and lands at the top.
    expect(window.history.scrollRestoration).toBe('manual');
  });
});
