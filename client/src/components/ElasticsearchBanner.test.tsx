import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { installFetchMock, jsonResponse } from '../test/fetchMock';
import {
  getElasticsearchState,
  reportElasticsearchUnavailable,
  resetElasticsearchState,
} from '../utils/elasticsearchStatus';
import { ElasticsearchBanner } from './ElasticsearchBanner';

const fetchMock = installFetchMock();

const healthy = () => jsonResponse({ status: 'ok', elasticsearch: 'ok', revision: 1 });
const down = () => jsonResponse({ status: 'degraded', elasticsearch: 'down', revision: 1 }, 503);
const readOnly = () => jsonResponse({ status: 'ok', elasticsearch: 'ok', revision: 1, writes: 'refused' });

/** The read-only message as the strip renders it, with the menu labels filled in */
const readOnlyMessage = () =>
  i18n.t('health.elasticsearchReadOnly', {
    refresh: i18n.t('reindex.start'),
    onlyMissing: i18n.t('reindex.onlyMissing'),
  });

/** The visible strip carries the retry, so the button says whether it is up */
const findRetry = () => screen.findByRole('button', { name: i18n.t('health.recheck') });
const queryRetry = () => screen.queryByRole('button', { name: i18n.t('health.recheck') });

/**
 * A live region has to be in the accessibility tree before its content
 * changes, or the change is never read out. So the region is there while the
 * stack is healthy, empty, and the messages land in that same node; only the
 * visible strip comes and goes.
 */
describe('ElasticsearchBanner', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetElasticsearchState();
  });

  it('keeps an empty live region and no strip while the stack is healthy', async () => {
    fetchMock.mockResolvedValue(healthy());

    render(<ElasticsearchBanner />);

    await waitFor(() => expect(getElasticsearchState()).toBe('ok'));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(queryRetry()).toBeNull();
  });

  it('announces the outage through the region that was there before it', async () => {
    fetchMock.mockResolvedValue(healthy());
    render(<ElasticsearchBanner />);
    const region = screen.getByRole('status');
    await waitFor(() => expect(getElasticsearchState()).toBe('ok'));

    act(() => reportElasticsearchUnavailable());

    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent(i18n.t('health.elasticsearchDown'));
    expect(queryRetry()).not.toBeNull();
  });

  it('announces a write refusal through the same region once a check finds it', async () => {
    fetchMock.mockResolvedValue(healthy());
    render(<ElasticsearchBanner />);
    const region = screen.getByRole('status');
    await waitFor(() => expect(getElasticsearchState()).toBe('ok'));

    // The usual way it shows up: the stack was fine, and the check that runs
    // when the user comes back to the tab finds the disk full
    fetchMock.mockResolvedValue(readOnly());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(region).toHaveTextContent(readOnlyMessage()));
    expect(screen.getByRole('status')).toBe(region);
  });

  it('shows the outage message in the strip when Elasticsearch is down', async () => {
    fetchMock.mockResolvedValue(down());

    render(<ElasticsearchBanner />);

    const strip = (await findRetry()).closest('.health-banner');
    expect(strip).toHaveTextContent(i18n.t('health.elasticsearchDown'));
    expect(screen.getByRole('status')).toHaveTextContent(i18n.t('health.elasticsearchDown'));
  });

  it('takes the strip down and keeps the region when the retry finds the cluster again', async () => {
    fetchMock.mockResolvedValue(down());
    const user = userEvent.setup();
    render(<ElasticsearchBanner />);
    const retry = await findRetry();

    fetchMock.mockResolvedValue(healthy());
    await user.click(retry);

    await waitFor(() => expect(queryRetry()).toBeNull());
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  describe('a cluster that refuses writes', () => {
    it('says search still works and names the full reindex that brings in the videos downloaded meanwhile', async () => {
      fetchMock.mockResolvedValue(readOnly());

      render(<ElasticsearchBanner />);

      const region = screen.getByRole('status');
      await waitFor(() => expect(region).toHaveTextContent(readOnlyMessage()));
      // The write after a download gives up after about 10.5 minutes of
      // retries, so the strip names the way back in the menu's own words: the
      // reindex, and the switch that would skip the folders already indexed
      expect(region).toHaveTextContent(i18n.t('reindex.start'));
      expect(region).toHaveTextContent(i18n.t('reindex.onlyMissing'));
      // The same strip as the outage, with the same retry
      expect((await findRetry()).closest('.health-banner')).toHaveTextContent(readOnlyMessage());
    });

    it('takes the strip down when the retry finds the writes taken again', async () => {
      fetchMock.mockResolvedValue(readOnly());
      const user = userEvent.setup();
      render(<ElasticsearchBanner />);
      const retry = await findRetry();

      fetchMock.mockResolvedValue(healthy());
      await user.click(retry);

      await waitFor(() => expect(queryRetry()).toBeNull());
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('names the outage instead once a request finds the cluster gone', async () => {
      fetchMock.mockResolvedValue(readOnly());
      render(<ElasticsearchBanner />);
      const region = screen.getByRole('status');
      await waitFor(() => expect(region).toHaveTextContent(readOnlyMessage()));

      act(() => reportElasticsearchUnavailable());

      expect(region).toHaveTextContent(i18n.t('health.elasticsearchDown'));
      expect(region).not.toHaveTextContent(readOnlyMessage());
    });
  });
});
