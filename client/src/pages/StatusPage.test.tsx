import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { StatusResponse } from '@shared/api';
import StatusPage from './StatusPage';
import type { FetchMock, MockResponse } from '../test/fetchMock';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => 'toast-id') },
}));

const statusResponse: StatusResponse = {
  videosFolderPath: ['/videos/a', '/videos/b'],
  folderConfigs: {
    '/videos/a': { channelUrl: 'https://yt/@a' },
    '/videos/b': null,
  },
  downloadDefaults: { maxHeight: 2160, subLangs: ['en'], writeComments: true },
  indexedFolders: ['/videos/a'],
  listExists: { '/videos/a': true, '/videos/b': false },
  status: 'ok',
};

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});

/**
 * StatusPage renders a FolderSection per configured path, and each of those
 * checks list.json on its own — hence the routing mock rather than a single
 * canned response.
 */
function installFetch(handlers: { status?: () => MockResponse } = {}): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/status') {
      return handlers.status?.() ?? json(statusResponse);
    }
    if (url.startsWith('/api/folder/list-exists')) {
      return json({ exists: false });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <StatusPage />
    </MemoryRouter>
  );

describe('StatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  it('shows a spinner until the status arrives', () => {
    renderPage();

    expect(screen.getByText('Ładowanie statusu...')).toBeInTheDocument();
  });

  it('renders one section per configured folder', async () => {
    renderPage();

    expect(await screen.findByText('/videos/a')).toBeInTheDocument();
    expect(screen.getByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Przejdź do listy filmów' })).toHaveAttribute(
      'href',
      '/videos'
    );
  });

  it('marks which folders already have an Elasticsearch index', async () => {
    renderPage();

    expect(await screen.findByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByText('indeks ES: gotowy')).toBeInTheDocument();
    expect(screen.getByText('indeks ES: brak')).toBeInTheDocument();
  });

  it('offers to create config.json for a folder that has none', async () => {
    renderPage();

    expect(await screen.findByText('/videos/b')).toBeInTheDocument();
    expect(screen.getByText('Plik config.json nie istnieje w tym folderze.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Utwórz config.json' })).toBeInTheDocument();
  });

  it('shows the error when the status request fails', async () => {
    installFetch({ status: () => json({ error: 'boom' }, 500) });
    renderPage();

    expect(await screen.findByText('Błąd: Failed to fetch status')).toBeInTheDocument();
  });

  it('says so when no folders are configured', async () => {
    installFetch({
      status: () => json({ ...statusResponse, videosFolderPath: [], folderConfigs: {} }),
    });
    renderPage();

    expect(await screen.findByText('Brak skonfigurowanych ścieżek')).toBeInTheDocument();
  });
});
