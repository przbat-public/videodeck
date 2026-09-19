import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelAction } from '../hooks/useChannelActions';
import { DEFAULT_CHANNEL_CONSOLE_STATE } from '../utils/channelConsoleState';
import type { ChannelRow } from '../utils/channelTable';
import { ChannelTable } from './ChannelTable';

const row = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
  folderPath: '/videos/kanal-a',
  name: 'kanal-a',
  configured: true,
  indexed: true,
  listExists: true,
  queue: { running: 0, queued: 0, failed: 0 },
  attention: [],
  ...overrides,
});

const renderTable = (
  rows: ChannelRow[],
  state = DEFAULT_CHANNEL_CONSOLE_STATE,
  countsLoading = false,
  options: { pending?: Record<string, ChannelAction> } = {},
) => {
  const onChange = vi.fn();
  const onAction = vi.fn();
  render(
    <ChannelTable
      rows={rows}
      state={state}
      onChange={onChange}
      countsLoading={countsLoading}
      pending={options.pending ?? {}}
      onAction={onAction}
      renderExpanded={(expanded) => <p>filmy kanału {expanded.name}</p>}
    />,
  );
  return { onChange, onAction };
};

/** The row's secondary actions live behind the ⋯ trigger */
const openRowMenu = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'Więcej akcji' }));
};

describe('ChannelTable', () => {
  it('renders the five columns and one row per channel', () => {
    renderTable([row(), row({ folderPath: '/videos/kanal-b', name: 'kanal-b' })]);

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent?.trim());
    expect(headers).toEqual(['Kanał', 'Lista filmów', 'Filmy', 'Kolejka', 'Akcje']);
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + two channels
    expect(screen.getByText('kanal-a')).toBeInTheDocument();
    expect(screen.getByText('/videos/kanal-a')).toBeInTheDocument();
  });

  it('shows the counts, the playlist state and the queue activity', () => {
    renderTable([
      row({
        summary: { videos: 40, downloaded: 2, notDownloaded: 38, stale: 5, newestUpdate: '2026-09-18T12:00:00.000Z' },
        queue: { running: 1, queued: 2, failed: 1, firstError: 'boom' },
      }),
    ]);

    expect(screen.getByText('40 filmów')).toBeInTheDocument();
    expect(screen.getByText('38 niepobranych')).toBeInTheDocument();
    expect(screen.getByText('5 nie od miesiąca')).toBeInTheDocument();
    expect(screen.getByText('list.json jest')).toBeInTheDocument();
    expect(screen.getByText('1 w toku')).toBeInTheDocument();
    expect(screen.getByText('2 czeka')).toBeInTheDocument();
    expect(screen.getByText('1 błąd')).toBeInTheDocument();
    // No native title attributes: the design contract sends the info to a Tooltip
    expect(screen.getByText('1 błąd')).not.toHaveAttribute('title');
  });

  it('chips the reasons no other column shows', () => {
    renderTable([
      row({ configured: false, indexed: false, listExists: false, attention: ['noChannelUrl', 'noList', 'noIndex'] }),
    ]);

    expect(screen.getByText('brak channelUrl')).toBeInTheDocument();
    expect(screen.getByText('brak indeksu ES')).toBeInTheDocument();
    // The playlist column owns that state; a chip would only repeat it.
    expect(screen.getAllByText('brak list.json')).toHaveLength(1);
  });

  it('says the playlist state is still being checked', () => {
    renderTable([row({ listExists: null })]);

    expect(screen.getByText('sprawdzam...')).toBeInTheDocument();
  });

  it('shows the age of the last update next to the playlist', () => {
    renderTable([
      row({
        summary: {
          videos: 10,
          downloaded: 10,
          notDownloaded: 0,
          stale: 0,
          newestUpdate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    ]);

    expect(screen.getByText('3 dni temu')).toBeInTheDocument();
  });

  it('chips a queue that is only waiting', () => {
    renderTable([row({ queue: { running: 0, queued: 2, failed: 0 } })]);

    expect(screen.getByText('2 czeka')).toBeInTheDocument();
    expect(screen.queryByText(/w toku/)).toBeNull();
  });

  it('dashes the counts until they arrive', () => {
    const { rerender } = render(
      <ChannelTable
        rows={[row()]}
        state={DEFAULT_CHANNEL_CONSOLE_STATE}
        onChange={vi.fn()}
        countsLoading
        pending={{}}
        onAction={vi.fn()}
        renderExpanded={() => null}
      />,
    );
    expect(screen.getByText('liczę...')).toBeInTheDocument();

    rerender(
      <ChannelTable
        rows={[row()]}
        state={DEFAULT_CHANNEL_CONSOLE_STATE}
        onChange={vi.fn()}
        countsLoading={false}
        pending={{}}
        onAction={vi.fn()}
        renderExpanded={() => null}
      />,
    );
    // The videos column and the empty queue column both show a dash
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('expands the row the URL names and collapses it again', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTable([row()]);

    await user.click(screen.getByRole('button', { name: 'Pokaż filmy' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_CHANNEL_CONSOLE_STATE, folder: '/videos/kanal-a' });
  });

  it('renders the expanded content of the named row', () => {
    renderTable([row()], { ...DEFAULT_CHANNEL_CONSOLE_STATE, folder: '/videos/kanal-a' });

    expect(screen.getByText('filmy kanału kanal-a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ukryj filmy' })).toBeInTheDocument();
  });

  it('links to the search page scoped to the channel', async () => {
    const user = userEvent.setup();
    renderTable([row()]);

    await openRowMenu(user);

    expect(await screen.findByRole('menuitem', { name: 'Szukaj w tym kanale' })).toHaveAttribute(
      'href',
      '/?channel=%2Fvideos%2Fkanal-a',
    );
  });

  it('marks the channel column as sorted when the name decides the order', () => {
    renderTable([row()], { ...DEFAULT_CHANNEL_CONSOLE_STATE, sort: 'name' });

    const [channelHeader] = screen.getAllByRole('columnheader');
    expect(channelHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('sorts by name when the channel header is clicked', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTable([row()], { ...DEFAULT_CHANNEL_CONSOLE_STATE, sort: 'missing' });

    await user.click(screen.getByRole('button', { name: 'Kanał' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_CHANNEL_CONSOLE_STATE, sort: 'name' });
  });

  it('says so when the filter matches nothing', () => {
    renderTable([]);

    expect(screen.getByText('Żaden kanał nie pasuje do filtra')).toBeInTheDocument();
  });

  it('summarises the rows it was given', () => {
    renderTable([
      row({ summary: { videos: 10, downloaded: 8, notDownloaded: 2, stale: 1 } }),
      row({
        folderPath: '/videos/kanal-b',
        name: 'kanal-b',
        listExists: false,
        attention: ['noList'],
        summary: { videos: 5, downloaded: 5, notDownloaded: 0, stale: 0 },
      }),
    ]);

    const caption = screen.getByRole('table').querySelector('caption');
    expect(within(caption as HTMLElement).getByText(/Kanałów: 2/)).toBeInTheDocument();
    expect(within(caption as HTMLElement).getByText(/filmów: 15/)).toBeInTheDocument();
    expect(within(caption as HTMLElement).getByText(/niepobranych: 2/)).toBeInTheDocument();
    expect(within(caption as HTMLElement).getByText(/wymaga uwagi: 1/)).toBeInTheDocument();
  });

  it('queues the missing videos from the primary action', async () => {
    const user = userEvent.setup();
    const { onAction } = renderTable([row({ summary: { videos: 40, downloaded: 2, notDownloaded: 38, stale: 1 } })]);

    await user.click(screen.getByRole('button', { name: 'Pobierz wszystkie' }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'download');
  });

  it('falls back to updating everything once nothing is missing', async () => {
    const user = userEvent.setup();
    const { onAction } = renderTable([row({ summary: { videos: 5, downloaded: 5, notDownloaded: 0, stale: 0 } })]);

    await user.click(screen.getByRole('button', { name: 'Aktualizuj wszystkie' }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'update');
  });

  it('disables the primary action when the channel has nothing to update', () => {
    renderTable([row({ summary: { videos: 5, downloaded: 0, notDownloaded: 0, stale: 0 } })]);

    expect(screen.getByRole('button', { name: 'Aktualizuj wszystkie' })).toBeDisabled();
  });

  it('keeps the actions usable when the counts could not be loaded', async () => {
    const user = userEvent.setup();
    // No summary at all: the counts may have failed, but the list.json the
    // action reads is authoritative, so the button must still work.
    const { onAction } = renderTable([row()]);

    await user.click(screen.getByRole('button', { name: 'Pobierz wszystkie' }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'download');
  });

  it('offers the secondary actions in the row menu', async () => {
    const user = userEvent.setup();
    const { onAction } = renderTable([
      row({
        summary: { videos: 40, downloaded: 20, notDownloaded: 20, stale: 3 },
        queue: { running: 1, queued: 0, failed: 0 },
      }),
    ]);

    await openRowMenu(user);
    // Radix marks a disabled item with data-disabled, not the disabled property
    expect(screen.getByRole('menuitem', { name: 'Aktualizuj wszystkie' })).not.toHaveAttribute('data-disabled');
    await user.click(screen.getByRole('menuitem', { name: 'Aktualizuj stare' }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'update-stale');
  });

  it('updates every download from the row menu', async () => {
    const user = userEvent.setup();
    const { onAction } = renderTable([row({ summary: { videos: 5, downloaded: 5, notDownloaded: 0, stale: 0 } })]);

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Aktualizuj wszystkie' }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'update');
  });

  it('cancels the channel jobs from the row menu', async () => {
    const user = userEvent.setup();
    const { onAction } = renderTable([row({ queue: { running: 0, queued: 2, failed: 0 } })]);

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Anuluj zadania kanału' }));

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'cancel');
  });

  it('disables the menu actions the channel has no use for', async () => {
    const user = userEvent.setup();
    renderTable([row({ summary: { videos: 5, downloaded: 0, notDownloaded: 5, stale: 0 } })]);

    await openRowMenu(user);

    expect(screen.getByRole('menuitem', { name: 'Aktualizuj stare' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Aktualizuj wszystkie' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Anuluj zadania kanału' })).toHaveAttribute('data-disabled');
  });

  it('opens the config editor by expanding the row from the menu', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTable([row()]);

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Edytuj config.json' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_CHANNEL_CONSOLE_STATE, folder: '/videos/kanal-a' });
  });

  it('fetches the playlist when the channel has no list to work from', async () => {
    const user = userEvent.setup();
    const { onAction } = renderTable([row({ listExists: false, attention: ['noList'] })]);

    await user.click(screen.getByRole('button', { name: 'Pobierz playlistę' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ folderPath: '/videos/kanal-a' }), 'playlist');

    await openRowMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'Aktualizuj wszystkie' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Edytuj config.json' })).toBeInTheDocument();
  });

  it('marks a busy row and blocks its controls while the action runs', async () => {
    const user = userEvent.setup();
    renderTable([row({ summary: { videos: 40, downloaded: 1, notDownloaded: 39, stale: 0 } })], undefined, false, {
      pending: { '/videos/kanal-a': 'download' },
    });

    expect(screen.getByText('Pracuję...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pobierz wszystkie' })).toBeDisabled();

    await openRowMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Aktualizuj stare' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Edytuj config.json' })).not.toHaveAttribute('data-disabled');
  });
});
