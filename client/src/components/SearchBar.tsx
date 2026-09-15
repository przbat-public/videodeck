import type { SortOption } from '@videodeck/shared/api';
import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import type { SearchState } from '../utils/searchUrlState';
import { SORT_OPTIONS } from '../utils/searchUrlState';
import { Button } from './ui/Button';
import { Select } from './ui/Select';

interface SearchBarProps {
  /** The committed search — what the URL and the results currently reflect */
  query: string;
  sort: SortOption;
  category: string;
  channel: string;
  dateFrom: string;
  dateTo: string;
  /** Categories offered by the server; the filter hides when there is nothing to pick */
  categories?: string[];
  /** Channel names offered by the server; the filter hides when there is nothing to pick */
  channels?: string[];
  onChange: (next: SearchState) => void;
}

const MIN_SEARCH_LENGTH = 3;
const DEBOUNCE_DELAY = 300;

/** A phrase worth searching for: nothing at all, or enough to be selective */
const isSearchable = (trimmed: string): boolean => trimmed.length === 0 || trimmed.length >= MIN_SEARCH_LENGTH;

/** `20240105` ↔ `2024-01-05` (what a date input displays) */
const toDisplayDate = (digits: string): string =>
  digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : '';
const toDateDigits = (value: string): string => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.replace(/\D/g, ''));
  if (!match) {
    return '';
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? match[0] : '';
};

export default function SearchBar({
  query,
  sort,
  category,
  channel,
  dateFrom,
  dateTo,
  categories = [],
  channels = [],
  onChange,
}: SearchBarProps) {
  const { t } = useTranslation();
  // The input is typed into faster than we want to search, so it keeps its
  // own text and commits it to `onChange` after a pause. `query` is the
  // committed value; the two only differ while the user is typing.
  const [text, setText] = useState(query);
  const [seenQuery, setSeenQuery] = useState(query);
  if (query !== seenQuery) {
    // The committed query changed outside the input (deep link, history
    // navigation): show it. Surrounding whitespace is the one difference
    // we tolerate, otherwise our own commit would eat a space being typed.
    setSeenQuery(query);
    if (query !== text.trim()) {
      setText(query);
    }
  }

  // The debounced copies of what the user is typing (see useDebouncedValue);
  // the effects below commit them to `onChange` once the typing pauses.
  const debouncedText = useDebouncedValue(text, DEBOUNCE_DELAY);

  // The effects commit only when the debounced value itself changed — the
  // ref guard stops external prop updates (deep links, history) from
  // re-committing the stale pending value.
  const committedTextRef = useRef(debouncedText);
  useEffect(() => {
    if (debouncedText === committedTextRef.current) {
      return;
    }
    // The debounced copy lags the input while its timer is pending. An
    // Enter commit changes the query prop, which re-runs this effect with
    // the stale copy; committing it would overwrite the Enter commit. The
    // fresh debounce fires later and finds the ref already set.
    if (debouncedText !== text) {
      return;
    }
    committedTextRef.current = debouncedText;
    const trimmed = debouncedText.trim();
    if (trimmed === query || !isSearchable(trimmed)) {
      return;
    }
    onChange({ query: trimmed, sort, category, channel, dateFrom, dateTo });
  }, [debouncedText, text, query, sort, category, channel, dateFrom, dateTo, onChange]);

  /**
   * Selects commit right away. A phrase still too short to search stays in
   * the input, and the commit keeps the query the results already show.
   */
  const commitWith = (patch: Partial<SearchState>) => {
    const trimmed = text.trim();
    onChange({
      query: isSearchable(trimmed) ? trimmed : query,
      sort,
      category,
      channel,
      dateFrom,
      dateTo,
      ...patch,
    });
  };

  const handleClear = () => {
    setText('');
    commitWith({ query: '' });
  };

  /** Enter commits right away instead of waiting out the debounce */
  const handlePhraseKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return;
    }
    const trimmed = text.trim();
    if (!isSearchable(trimmed) || trimmed === query) {
      return;
    }
    // Stop the pending debounce from re-committing the same phrase
    committedTextRef.current = trimmed;
    onChange({ query: trimmed, sort, category, channel, dateFrom, dateTo });
  };

  const categoryOptions =
    category.length > 0 && !categories.includes(category)
      ? [...categories, category] // a URL may name a category the list does not (yet) know
      : categories;
  const channelOptions =
    channel.length > 0 && !channels.includes(channel)
      ? [...channels, channel] // a URL may name a channel the list does not (yet) know
      : channels;

  return (
    <div className="search-bar">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handlePhraseKeyDown}
        placeholder={t('search.placeholder')}
        aria-label={t('search.queryLabel')}
        className="search-input"
      />
      {/* 1–2 characters never commit (MIN_SEARCH_LENGTH) — say so instead of
          silently ignoring the keystrokes */}
      {text.trim().length > 0 && text.trim().length < MIN_SEARCH_LENGTH && (
        <span className="search-hint" role="status">
          {t('search.minLengthHint', { min: MIN_SEARCH_LENGTH })}
        </span>
      )}
      {categoryOptions.length > 0 && (
        <Select
          value={category}
          onChange={(value) => commitWith({ category: value })}
          className="category-select"
          aria-label={t('search.category')}
          items={[
            { value: '', label: t('search.allCategories') },
            ...categoryOptions.map((name) => ({ value: name, label: name })),
          ]}
        />
      )}
      <Select
        value={sort}
        onChange={(value) => commitWith({ sort: value as SortOption })}
        className="sort-select"
        aria-label={t('search.sort')}
        items={SORT_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
      />
      {channelOptions.length > 0 && (
        <Select
          value={channel}
          onChange={(value) => commitWith({ channel: value })}
          className="channel-select"
          aria-label={t('search.channel')}
          items={[
            { value: '', label: t('search.allChannels') },
            ...channelOptions.map((name) => ({ value: name, label: name })),
          ]}
        />
      )}
      <input
        type="date"
        value={toDisplayDate(dateFrom)}
        onChange={(e) => commitWith({ dateFrom: toDateDigits(e.target.value) })}
        className="date-filter"
        aria-label={t('search.fromDate')}
      />
      <input
        type="date"
        value={toDisplayDate(dateTo)}
        onChange={(e) => commitWith({ dateTo: toDateDigits(e.target.value) })}
        className="date-filter"
        aria-label={t('search.toDate')}
      />
      {text && (
        <Button onClick={handleClear} size="small">
          {t('search.clear')}
        </Button>
      )}
    </div>
  );
}
