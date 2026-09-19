import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouteError from './RouteError';

/** Renders the route error the way a failing loader reaches it */
function renderRouteError(): void {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        loader: () => {
          throw new Error('loader exploded');
        },
        element: <div>never rendered</div>,
        errorElement: <RouteError />,
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('RouteError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the failure inside a main landmark and moves focus to it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* the component logs the route error on purpose */
    });
    // Stand in for the route change: whatever held focus is gone, so the
    // browser has dropped it back to the body. The suite shares one document
    // between files, so the blur has to be explicit.
    (document.activeElement as HTMLElement | null)?.blur();

    renderRouteError();

    expect(await screen.findByRole('heading', { name: 'Coś poszło nie tak.' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveClass('route-error');
    // The route change dropped focus to the body; the error screen has to take
    // it back, or a keyboard user is left at the top of the document. Router
    // may swap the landmark for the error element's own one, so retry.
    await waitFor(() => expect(document.activeElement).toBe(main));
    expect(screen.getByRole('link', { name: 'Wróć do strony startowej' })).toHaveAttribute('href', '/');
  });
});
