import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockResponse } from '../test/fetchMock';
import { installFetchMock } from '../test/fetchMock';
import { FolderSection } from './FolderSection';

const fetchMock = installFetchMock();

const json = (body: unknown, status = 200): MockResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const downloadDefaults = { maxHeight: 2160, subLangs: ['en'], writeComments: true };

describe('FolderSection', () => {
  it('renders the sections without a header or a card of its own', () => {
    render(
      <FolderSection
        folderPath="/videos/a"
        initialConfig={{ channelUrl: 'https://www.youtube.com/@a' }}
        downloadDefaults={downloadDefaults}
        initialListExists={true}
        editingConfig={false}
        onEditingFinished={vi.fn()}
        onConfigUpdate={vi.fn()}
      />,
    );

    // The channel row above already names the channel and shows the index
    // warning, so a second heading in here would only repeat it
    expect(screen.queryByRole('heading', { name: '/videos/a' })).toBeNull();
    expect(screen.queryByText('/videos/a')).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('checks list.json existence when the status did not report it', async () => {
    fetchMock.mockResolvedValue(json({ exists: true }));
    render(
      <FolderSection
        folderPath="/videos/a"
        initialConfig={{ channelUrl: 'https://www.youtube.com/@a' }}
        downloadDefaults={downloadDefaults}
        initialListExists={null}
        editingConfig={false}
        onEditingFinished={vi.fn()}
        onConfigUpdate={vi.fn()}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/folder/list-exists?folderPath=%2Fvideos%2Fa'));
  });

  it('survives a failed existence check (best effort)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    render(
      <FolderSection
        folderPath="/videos/b"
        initialConfig={{ channelUrl: 'https://www.youtube.com/@b' }}
        downloadDefaults={downloadDefaults}
        initialListExists={null}
        editingConfig={false}
        onEditingFinished={vi.fn()}
        onConfigUpdate={vi.fn()}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
