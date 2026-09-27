// polish-ok: asserts the default-locale label of the back link

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { AppLayout, MAIN_CONTENT_ID } from './AppLayout';
import { useRegisterMenuSections } from './appMenuRegistry';

const user = userEvent.setup();

/** Registers one section; the button forces a re-render with the same content */
function RegisteringChild(): JSX.Element {
  const [count, setCount] = useState(0);
  useRegisterMenuSections([{ key: 'indexes', label: 'Indeksy', items: [{ key: 'r', label: 'Odśwież wyniki' }] }]);
  return (
    <button type="button" onClick={() => setCount((n) => n + 1)} data-count={count}>
      bump
    </button>
  );
}

/** Stands in for a routed page: the shell's skip link needs a target */
function PageStub(): JSX.Element {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1}>
      <RegisteringChild />
    </main>
  );
}

function renderLayout(url: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route path="video/:videoId" element={<PageStub />} />
          <Route index element={<PageStub />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppLayout', () => {
  it('offers the skip link as the first tab stop, pointing at the main landmark', async () => {
    renderLayout('/');

    const skipLink = screen.getByRole('link', { name: i18n.t('nav.skipToContent') });
    await user.tab();
    expect(document.activeElement).toBe(skipLink);

    // A skip link that points nowhere bypasses nothing
    const href = skipLink.getAttribute('href') ?? '';
    expect(href).toBe(`#${MAIN_CONTENT_ID}`);
    expect(document.querySelector(href)).not.toBeNull();
  });

  it('shows the back link only on the detail page', () => {
    renderLayout('/');
    expect(screen.queryByRole('link', { name: /Wróć do listy/ })).not.toBeInTheDocument();

    renderLayout('/video/v1');
    expect(screen.getByRole('link', { name: /Wróć do listy/ })).toHaveAttribute('href', '/');
  });

  it('keeps the registered sections stable when a page re-renders the same content', async () => {
    renderLayout('/');

    await user.click(screen.getByRole('button', { name: 'bump' }));

    // The re-register with identical content must not throw or drop items;
    // opening the menu proves the registry still serves the section.
    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));
    expect(await screen.findByRole('menuitem', { name: 'Odśwież wyniki' })).toBeInTheDocument();
  });
});
