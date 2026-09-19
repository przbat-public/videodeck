import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelConsoleState } from '../utils/channelConsoleState';
import { CHANNEL_FILTERS, CHANNEL_SORTS } from '../utils/channelConsoleState';
import { Select } from './ui/Select';

export interface ChannelFilterCounts {
  all: number;
  attention: number;
  queue: number;
  failed: number;
}

interface ChannelToolbarProps {
  state: ChannelConsoleState;
  /** Rows behind every chip, so the counts do not shift while typing */
  counts: ChannelFilterCounts;
  onChange: (next: ChannelConsoleState) => void;
}

/**
 * Above the channel table: the text filter, the filter chips and the sort
 * choice. Chips that would show zero channels stay visible but lose their
 * count, so the row keeps its shape while a filter is active.
 */
export function ChannelToolbar({ state, counts, onChange }: ChannelToolbarProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="channel-toolbar">
      <input
        type="search"
        className="channel-search"
        value={state.query}
        placeholder={t('channelConsole.searchPlaceholder')}
        aria-label={t('channelConsole.searchPlaceholder')}
        onChange={(event) => onChange({ ...state, query: event.target.value })}
      />

      <div className="channel-filters">
        {CHANNEL_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="channel-chip"
            aria-pressed={state.filter === option.value}
            onClick={() => onChange({ ...state, filter: option.value })}
          >
            {t(option.labelKey, { count: counts[option.value] })}
          </button>
        ))}
      </div>

      <Select
        value={state.sort}
        onChange={(value) => onChange({ ...state, sort: value as ChannelConsoleState['sort'] })}
        aria-label={t('channelConsole.sortLabel')}
        className="channel-sort"
        items={CHANNEL_SORTS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
      />
    </div>
  );
}
