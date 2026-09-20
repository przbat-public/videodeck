import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { resetElasticsearchState } from '../utils/elasticsearchStatus';
import { ElasticsearchBanner } from './ElasticsearchBanner';

const fetchMock = installFetchMock();

describe('ElasticsearchBanner', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('says nothing while the stack is healthy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));

    render(<ElasticsearchBanner />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names what is off and what still works when Elasticsearch is down', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down' }, 503));

    render(<ElasticsearchBanner />);

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Elasticsearch nie odpowiada');
    expect(banner).toHaveTextContent('pobieranie i lista filmów działają dalej');
  });

  it('clears itself when the retry finds the cluster again', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down' }, 503));
    const user = userEvent.setup();
    render(<ElasticsearchBanner />);
    await screen.findByRole('status');

    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok' }));
    await user.click(screen.getByRole('button', { name: 'Sprawdź ponownie' }));

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
