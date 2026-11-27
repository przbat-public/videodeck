import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import { reportElasticsearchUnavailable, resetElasticsearchState } from '../utils/elasticsearchStatus';
import { ElasticsearchBanner } from './ElasticsearchBanner';

const fetchMock = installFetchMock();

describe('ElasticsearchBanner', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('says nothing while the stack is healthy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok', revision: 1 }));

    render(<ElasticsearchBanner />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names what is off and what still works when Elasticsearch is down', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down', revision: 1 }, 503));

    render(<ElasticsearchBanner />);

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Elasticsearch nie odpowiada');
    expect(banner).toHaveTextContent('pobieranie i lista filmów działają dalej');
  });

  it('clears itself when the retry finds the cluster again', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded', elasticsearch: 'down', revision: 1 }, 503));
    const user = userEvent.setup();
    render(<ElasticsearchBanner />);
    await screen.findByRole('status');

    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok', revision: 1 }));
    await user.click(screen.getByRole('button', { name: 'Sprawdź ponownie' }));

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  describe('a cluster that refuses writes', () => {
    const readOnly = () => jsonResponse({ status: 'ok', elasticsearch: 'ok', revision: 1, writes: 'refused' });

    it('says search still works and new videos do not reach it, in the same strip', async () => {
      fetchMock.mockResolvedValue(readOnly());

      render(<ElasticsearchBanner />);

      const banner = await screen.findByRole('status');
      expect(banner).toHaveTextContent(i18n.t('health.elasticsearchReadOnly'));
      expect(banner).toHaveClass('health-banner');
    });

    it('clears itself when the retry finds the writes taken again', async () => {
      fetchMock.mockResolvedValue(readOnly());
      const user = userEvent.setup();
      render(<ElasticsearchBanner />);
      await screen.findByRole('status');

      fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', elasticsearch: 'ok', revision: 1 }));
      await user.click(screen.getByRole('button', { name: i18n.t('health.recheck') }));

      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    });

    it('names the outage instead once a request finds the cluster gone', async () => {
      fetchMock.mockResolvedValue(readOnly());
      render(<ElasticsearchBanner />);
      await screen.findByRole('status');

      act(() => reportElasticsearchUnavailable());

      expect(screen.getByRole('status')).toHaveTextContent(i18n.t('health.elasticsearchDown'));
      expect(screen.getByRole('status')).not.toHaveTextContent(i18n.t('health.elasticsearchReadOnly'));
    });
  });
});
