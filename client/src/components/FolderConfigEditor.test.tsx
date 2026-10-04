import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { FetchMock } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { FolderConfigEditor } from './FolderConfigEditor';

const FOLDER = '/videos/channel-a';
const defaults: DownloadOptions = { maxHeight: 2160, subLangs: ['en'], writeComments: true };

/**
 * The editor is the dialog the console's row menu opens, so the harness is
 * that caller: a button standing in for the menu entry, the config the console
 * holds (it hands over whatever its status says, and a test pushes a fresh one
 * the way a status reload does), and the row's ⋯ trigger, which outlives the
 * dialog and is where focus goes back.
 */
function EditorHarness({
  config,
  knownCategories,
  downloadDefaults,
  onConfigUpdate,
}: {
  config: FolderConfig | null;
  knownCategories: string[];
  downloadDefaults: DownloadOptions;
  onConfigUpdate: (folderPath: string, config: FolderConfig | null) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(null);

  return (
    <div>
      <button
        type="button"
        onClick={(event) => {
          setReturnFocus(event.currentTarget);
          setOpen(true);
        }}
      >
        Edytuj konfigurację
      </button>
      {open && (
        <FolderConfigEditor
          folderPath={FOLDER}
          initialConfig={config}
          downloadDefaults={downloadDefaults}
          knownCategories={knownCategories}
          returnFocus={returnFocus}
          onClose={() => setOpen(false)}
          onConfigUpdate={onConfigUpdate}
        />
      )}
    </div>
  );
}

const renderEditor = (
  config: FolderConfig | null,
  knownCategories: string[] = [],
  downloadDefaults: DownloadOptions = defaults,
) => {
  const onConfigUpdate = vi.fn();
  const harness = (current: FolderConfig | null) => (
    <EditorHarness
      config={current}
      knownCategories={knownCategories}
      downloadDefaults={downloadDefaults}
      onConfigUpdate={onConfigUpdate}
    />
  );
  const view = render(harness(config));
  return {
    onConfigUpdate,
    /** What the console holds once its status has been read again */
    showConfig: (next: FolderConfig | null): void => {
      view.rerender(harness(next));
    },
  };
};

const lastPutBody = (fetchMock: FetchMock) => {
  const lastCall = fetchMock.mock.calls.at(-1);
  if (!lastCall) throw new Error('fetch was not called');
  return JSON.parse(String(lastCall[1]?.body));
};

describe('FolderConfigEditor', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  it('shows the fields in a dialog only after clicking edit', async () => {
    const user = userEvent.setup();
    renderEditor({ channelUrl: 'https://yt/@a' });

    expect(screen.queryByLabelText('Adres kanału YouTube:')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    // The form is a modal dialog named after what it edits, and the control
    // that opened it stays on the page behind
    const dialog = screen.getByRole('dialog', { name: i18n.t('config.title') });
    expect(within(dialog).getByText(FOLDER)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Adres kanału YouTube:')).toHaveValue('https://yt/@a');
  });

  it('shows defaults for keys missing from config.json', async () => {
    const user = userEvent.setup();
    renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveTextContent('Domyślnie (2160p)');
    expect(screen.getByLabelText('Pobieraj napisy')).toBeChecked();
    expect(screen.getByLabelText('Języki napisów (po przecinku):')).toHaveAttribute('placeholder', 'domyślnie: en');
    expect(screen.getByLabelText('Pobieraj komentarze')).toBeChecked();
  });

  it('names the server default, including an empty one', async () => {
    const user = userEvent.setup();
    // The folder keeps its own subtitle languages, so the field is on screen
    // while the server default behind it is empty
    renderEditor({ channelUrl: 'https://yt/@a', subLangs: ['pl'] }, [], {
      maxHeight: 2160,
      subLangs: [],
      writeComments: true,
      extraArgs: ['--no-playlist'],
    });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    // A server with no subtitle languages says "none" rather than an empty list
    expect(screen.getByLabelText('Języki napisów (po przecinku):')).toHaveAttribute('placeholder', 'domyślnie: brak');
    // The extra arguments default reads back as the flags it would pass
    expect(screen.getByText('domyślnie: --no-playlist')).toBeInTheDocument();
  });

  it('shows explicit values from config.json', async () => {
    const user = userEvent.setup();
    renderEditor({
      channelUrl: 'https://yt/@a',
      maxHeight: 1080,
      subLangs: [],
      writeComments: false,
    });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveTextContent('1080p');
    expect(screen.getByLabelText('Pobieraj napisy')).not.toBeChecked();
    expect(screen.getByLabelText('Pobieraj komentarze')).not.toBeChecked();
  });

  it('saves the edited download options', async () => {
    const user = userEvent.setup();
    const saved = {
      channelUrl: 'https://yt/@a',
      maxHeight: 1080,
      subLangs: ['pl', 'en'],
      writeComments: false,
      impersonate: false,
      sponsorblockRemove: false,
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, config: saved }) });
    const { onConfigUpdate, showConfig } = renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    await user.click(screen.getByLabelText('Maks. rozdzielczość:'));
    await user.click(await screen.findByRole('option', { name: '1080p' }));
    const subLangs = screen.getByLabelText('Języki napisów (po przecinku):');
    await user.clear(subLangs);
    await user.type(subLangs, 'pl, en');
    await user.click(screen.getByLabelText('Pobieraj komentarze'));
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(onConfigUpdate).toHaveBeenCalledWith(FOLDER, saved));
    expect(fetchMock).toHaveBeenCalledWith('/api/folder/config', expect.objectContaining({ method: 'PUT' }));
    expect(lastPutBody(fetchMock)).toEqual({ folderPath: FOLDER, config: saved });
    // A saved form closes itself: the console behind it is the page to be on
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The console keeps what the save answered, and the next open reads it back
    showConfig(saved);
    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveTextContent('1080p');
    expect(screen.getByLabelText('Języki napisów (po przecinku):')).toHaveValue('pl, en');
  });

  it('unchecking subtitles stores an empty subLangs array', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor(null);

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    const channelInput = screen.getByLabelText('Adres kanału YouTube:');
    await user.clear(channelInput);
    await user.type(channelInput, 'https://yt/@new');
    await user.click(screen.getByLabelText('Pobieraj napisy'));
    expect(screen.queryByLabelText('Języki napisów (po przecinku):')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toEqual({
      channelUrl: 'https://yt/@new',
      subLangs: [],
      writeComments: true,
      impersonate: false,
      sponsorblockRemove: false,
    });
  });

  it('saves extra yt-dlp arguments as an array', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    const extraArgs = screen.getByLabelText('Dodatkowe argumenty yt-dlp:');
    await user.clear(extraArgs);
    await user.type(extraArgs, '--cookies-from-browser chrome --proxy http://127.0.0.1:8080');
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toEqual({
      channelUrl: 'https://yt/@a',
      writeComments: true,
      extraArgs: ['--cookies-from-browser', 'chrome', '--proxy', 'http://127.0.0.1:8080'],
      impersonate: false,
      sponsorblockRemove: false,
    });
  });

  it('shows the server validation error', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'maxHeight must be an integer between 144 and 4320' }),
    });
    renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    expect(await screen.findByText('Błąd: maxHeight must be an integer between 144 and 4320')).toBeInTheDocument();
  });

  it('falls back to its own message when the save fails without a body', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, json: async () => null });
    renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    expect(await screen.findByText(i18n.t('app.error', { message: i18n.t('errors.saveConfig') }))).toBeInTheDocument();
  });

  it('reports a save that failed without an Error', async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue('boom');
    renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    expect(await screen.findByText(i18n.t('app.error', { message: i18n.t('errors.occurred') }))).toBeInTheDocument();
  });

  it('saves the category and suggests the ones other folders use', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ channelUrl: 'https://yt/@a', category: 'fpv' }, ['fpv', 'psychology']);

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    const input = screen.getByLabelText('Kategoria kanału:');
    expect(input).toHaveValue('fpv');
    // datalist options carry no accessible role, so read them off the DOM
    const suggestions = [...document.querySelectorAll('datalist option')].map((option) => option.getAttribute('value'));
    expect(suggestions).toEqual(['fpv', 'psychology']);
    expect(input).toHaveAttribute('list', 'categories-videos-channel-a');

    await user.clear(input);
    await user.type(input, 'lego');
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toEqual({
      channelUrl: 'https://yt/@a',
      category: 'lego',
      writeComments: true,
      impersonate: false,
      sponsorblockRemove: false,
    });
  });

  it('turns a folder into a collection and hides the channel URL for it', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ writeComments: true });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    expect(screen.getByLabelText('Adres kanału YouTube:')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Kolekcja pojedynczych pobrań/ }));
    expect(screen.queryByLabelText('Adres kanału YouTube:')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toMatchObject({ kind: 'collection' });
  });

  it('clearing the category drops it from config.json', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ channelUrl: 'https://yt/@a', category: 'fpv' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    const category = screen.getByLabelText('Kategoria kanału:');
    await user.clear(category);
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).not.toHaveProperty('category');
  });

  it('cancel restores the previous values', async () => {
    const user = userEvent.setup();
    renderEditor({ channelUrl: 'https://yt/@a', maxHeight: 720 });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    await user.click(screen.getByLabelText('Maks. rozdzielczość:'));
    await user.click(await screen.findByRole('option', { name: '2160p' }));
    await user.click(screen.getByRole('button', { name: 'Anuluj' }));

    expect(screen.queryByLabelText('Maks. rozdzielczość:')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveTextContent('720p');
  });

  it('adopts a config the console replaces while the form is open', async () => {
    const user = userEvent.setup();
    const { showConfig } = renderEditor({ channelUrl: 'https://yt/@a', maxHeight: 720 });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    // The console re-read the status, so the open dialog gets a fresh config
    // object under it; what the form shows is the config it was handed
    showConfig({ channelUrl: 'https://yt/@a', maxHeight: 2160 });

    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveTextContent('2160p');
  });

  it('saves the yt-dlp feature toggles (impersonate, SponsorBlock, fragments)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ channelUrl: 'https://yt/@a' });

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    await user.click(screen.getByRole('checkbox', { name: /Podszywaj się pod przeglądarkę/ }));
    await user.click(screen.getByRole('checkbox', { name: /segmenty sponsorskie/ }));
    await user.click(screen.getByLabelText('Równoległe fragmenty pobierania:'));
    await user.click(await screen.findByRole('option', { name: '4' }));
    await user.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toEqual({
      channelUrl: 'https://yt/@a',
      writeComments: true,
      impersonate: true,
      sponsorblockRemove: true,
      concurrentFragments: 4,
    });
  });
});
