import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FolderConfigEditor } from './FolderConfigEditor';
import type { DownloadOptions, FolderConfig } from '@shared/api';
import { installFetchMock } from '../test/fetchMock';
import type { FetchMock } from '../test/fetchMock';

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
    />
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

  it('shows the fields only after clicking edit', () => {
    renderEditor({ channelUrl: 'https://yt/@a' });

    expect(screen.queryByLabelText('Adres kanału YouTube:')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    expect(screen.getByLabelText('Adres kanału YouTube:')).toHaveValue('https://yt/@a');
    expect(screen.queryByRole('button', { name: 'Edytuj konfigurację' })).toBeNull();
  });

  it('shows defaults for keys missing from config.json', () => {
    renderEditor({ channelUrl: 'https://yt/@a' });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveValue('');
    expect(screen.getByText('Domyślnie (2160p)')).toBeInTheDocument();
    expect(screen.getByLabelText('Pobieraj napisy')).toBeChecked();
    expect(screen.getByLabelText('Języki napisów (po przecinku):')).toHaveAttribute(
      'placeholder',
      'domyślnie: en'
    );
    expect(screen.getByLabelText('Pobieraj komentarze')).toBeChecked();
  });

  it('shows explicit values from config.json', () => {
    renderEditor({
      channelUrl: 'https://yt/@a',
      maxHeight: 1080,
      subLangs: [],
      writeComments: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));

    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveValue('1080');
    expect(screen.getByLabelText('Pobieraj napisy')).not.toBeChecked();
    expect(screen.getByLabelText('Pobieraj komentarze')).not.toBeChecked();
  });

  it('saves the edited download options', async () => {
    const saved = {
      channelUrl: 'https://yt/@a',
      maxHeight: 1080,
      subLangs: ['pl', 'en'],
      writeComments: false,
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, config: saved }) });
    const { onConfigUpdate } = renderEditor({ channelUrl: 'https://yt/@a' });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    fireEvent.change(screen.getByLabelText('Maks. rozdzielczość:'), { target: { value: '1080' } });
    fireEvent.change(screen.getByLabelText('Języki napisów (po przecinku):'), {
      target: { value: 'pl, en' },
    });
    fireEvent.click(screen.getByLabelText('Pobieraj komentarze'));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(onConfigUpdate).toHaveBeenCalledWith(FOLDER, saved));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/folder/config',
      expect.objectContaining({ method: 'PUT' })
    );
    expect(lastPutBody(fetchMock)).toEqual({ folderPath: FOLDER, config: saved });

    fireEvent.click(await screen.findByRole('button', { name: 'Edytuj konfigurację' }));
    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveValue('1080');
    expect(screen.getByLabelText('Języki napisów (po przecinku):')).toHaveValue('pl, en');
  });

  it('unchecking subtitles stores an empty subLangs array', async () => {
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor(null);

    fireEvent.click(screen.getByRole('button', { name: 'Utwórz config.json' }));
    fireEvent.change(screen.getByLabelText('Adres kanału YouTube:'), {
      target: { value: 'https://yt/@new' },
    });
    fireEvent.click(screen.getByLabelText('Pobieraj napisy'));
    expect(screen.queryByLabelText('Języki napisów (po przecinku):')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toEqual({
      channelUrl: 'https://yt/@new',
      subLangs: [],
      writeComments: true,
    });
  });

  it('shows the server validation error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'maxHeight must be an integer between 144 and 4320' }),
    });
    renderEditor({ channelUrl: 'https://yt/@a' });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    expect(
      await screen.findByText('Błąd: maxHeight must be an integer between 144 and 4320')
    ).toBeInTheDocument();
  });

  it('saves the category and suggests the ones other folders use', async () => {
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ channelUrl: 'https://yt/@a', category: 'fpv' }, ['fpv', 'psychology']);

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    const input = screen.getByLabelText('Kategoria kanału:');
    expect(input).toHaveValue('fpv');
    // datalist options carry no accessible role, so read them off the DOM
    const suggestions = [...document.querySelectorAll('datalist option')].map((option) =>
      option.getAttribute('value')
    );
    expect(suggestions).toEqual(['fpv', 'psychology']);
    expect(input).toHaveAttribute('list', 'categories-videos-channel-a');

    fireEvent.change(input, { target: { value: '  lego  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).toEqual({
      channelUrl: 'https://yt/@a',
      category: 'lego',
      writeComments: true,
    });
  });

  it('clearing the category drops it from config.json', async () => {
    fetchMock.mockImplementation(async (_url, init) => ({
      ok: true,
      json: async () => ({ success: true, config: JSON.parse(String(init?.body)).config }),
    }));
    renderEditor({ channelUrl: 'https://yt/@a', category: 'fpv' });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    fireEvent.change(screen.getByLabelText('Kategoria kanału:'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody(fetchMock).config).not.toHaveProperty('category');
  });

  it('cancel restores the previous values', () => {
    renderEditor({ channelUrl: 'https://yt/@a', maxHeight: 720 });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    fireEvent.change(screen.getByLabelText('Maks. rozdzielczość:'), { target: { value: '2160' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));

    expect(screen.queryByLabelText('Maks. rozdzielczość:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edytuj konfigurację' }));
    expect(screen.getByLabelText('Maks. rozdzielczość:')).toHaveValue('720');
  });
});
