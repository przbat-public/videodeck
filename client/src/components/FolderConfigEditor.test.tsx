import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DownloadOptions, FolderConfig } from '@videodeck/shared/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMock } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { FolderConfigEditor } from './FolderConfigEditor';

const FOLDER = '/videos/channel-a';
const defaults: DownloadOptions = { maxHeight: 2160, subLangs: ['en'], writeComments: true };

const renderEditor = (config: FolderConfig | null, knownCategories: string[] = []) => {
  const onConfigUpdate = vi.fn();
  render(
    <FolderConfigEditor
      folderPath={FOLDER}
      initialConfig={config}
      downloadDefaults={defaults}
      knownCategories={knownCategories}
      onConfigUpdate={onConfigUpdate}
    />,
  );
  return { onConfigUpdate };
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

  it('shows the fields only after clicking edit', async () => {
    const user = userEvent.setup();
    renderEditor({ channelUrl: 'https://yt/@a' });

    expect(screen.queryByLabelText('Adres kanału YouTube:')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    expect(screen.getByLabelText('Adres kanału YouTube:')).toHaveValue('https://yt/@a');
    expect(screen.queryByRole('button', { name: 'Edytuj konfigurację' })).toBeNull();
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
    const { onConfigUpdate } = renderEditor({ channelUrl: 'https://yt/@a' });

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

    await user.click(await screen.findByRole('button', { name: 'Edytuj konfigurację' }));
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

    await user.click(screen.getByRole('button', { name: 'Utwórz config.json' }));
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
