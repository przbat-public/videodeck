// polish-ok: asserts the default-locale labels of the top bar menu

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppMenu } from './AppMenu';
import type { AppMenuSectionSpec } from './appMenuRegistry';
import { RegisterSectionsContext, SectionsContext, sectionsSignature } from './appMenuRegistry';

const user = userEvent.setup();

/** The real provider lives in AppLayout; the tests need a seam with initial sections */
function TestMenuProvider({
  initialSections,
  children,
}: {
  initialSections: AppMenuSectionSpec[];
  children: ReactNode;
}): JSX.Element {
  const [sections, setSections] = useState<AppMenuSectionSpec[]>(initialSections);
  const register = useCallback((next: AppMenuSectionSpec[]) => {
    setSections((prev) =>
      JSON.stringify(sectionsSignature(prev)) === JSON.stringify(sectionsSignature(next)) ? prev : next,
    );
  }, []);
  return (
    <RegisterSectionsContext value={register}>
      <SectionsContext value={sections}>{children}</SectionsContext>
    </RegisterSectionsContext>
  );
}

function renderMenu(
  sections: AppMenuSectionSpec[],
  { theme = 'light' as const, onThemeChange = vi.fn() } = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <TestMenuProvider initialSections={sections}>
        <AppMenu theme={theme} onThemeChange={onThemeChange} />
      </TestMenuProvider>
    </MemoryRouter>,
  );
}

describe('AppMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the registered sections between navigation and settings', async () => {
    renderMenu([
      {
        key: 'indexes',
        label: 'Indeksy',
        items: [{ key: 'refresh', label: 'Odśwież indeks', onSelect: vi.fn() }],
      },
    ]);

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));

    expect(screen.getByText('Nawigacja')).toBeInTheDocument();
    expect(screen.getByText('Lista filmów')).toBeInTheDocument();
    expect(screen.getByText('Pobieranie filmów')).toBeInTheDocument();
    expect(screen.getByText('Indeksy')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Odśwież indeks' })).toBeInTheDocument();
    expect(screen.getByText('Motyw')).toBeInTheDocument();
    expect(screen.getByText('Język')).toBeInTheDocument();
  });

  it('marks the active theme and reports the picked one', async () => {
    const onThemeChange = vi.fn();
    renderMenu([], { theme: 'light', onThemeChange });

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ciemny' }));

    expect(onThemeChange).toHaveBeenCalledWith('dark');
  });

  it('switches the language through the menu', async () => {
    renderMenu([]);

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'English' }));

    expect(await screen.findByRole('button', { name: 'App menu' })).toBeInTheDocument();
  });

  it('toggles a registered checkbox through the menu', async () => {
    const onCheckedChange = vi.fn();
    renderMenu([
      {
        key: 'indexes',
        label: 'Indeksy',
        items: [{ key: 'onlyMissing', label: 'tylko brakujące', checkbox: { checked: false, onCheckedChange } }],
      },
    ]);

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'tylko brakujące' }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('renders a label-less section and forwards disabled and title props', async () => {
    renderMenu([
      {
        key: 'bare',
        items: [{ key: 'reload', label: 'Odśwież wyniki', disabled: true, title: 'Ponów wyszukiwanie' }],
      },
      {
        key: 'check',
        items: [
          {
            key: 'cb',
            label: 'Włącz',
            checkbox: { checked: true, onCheckedChange: vi.fn() },
            disabled: true,
            title: 'Włącz opcję',
          },
        ],
      },
    ]);

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));

    const reload = await screen.findByRole('menuitem', { name: 'Odśwież wyniki' });
    expect(reload).toHaveAttribute('data-disabled');
    expect(reload).toHaveAttribute('title', 'Ponów wyszukiwanie');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Włącz' })).toHaveAttribute('data-disabled');
  });

  it('navigates through the navigation section', async () => {
    renderMenu([]);

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Lista filmów|Video list/ }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Menu aplikacji|App menu/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Pobieranie filmów|Download videos/ }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
