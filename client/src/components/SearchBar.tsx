import type { SortOption } from '@shared/api';
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
  /** Channel names offered by the server (datalist suggestions) */
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
  const digits = value.replace(/\D/g, '');
  return digits.length === 8 ? digits : '';
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
  const [channelText, setChannelText] = useState(channel);
  const [seenChannel, setSeenChannel] = useState(channel);
  if (channel !== seenChannel) {
    setSeenChannel(channel);
    if (channel !== channelText.trim()) {
      setChannelText(channel);
    }
  }
  const debouncedChannel = useDebouncedValue(channelText, DEBOUNCE_DELAY);

  // The effects commit only when the debounced value itself changed — the
  // ref guard stops external prop updates (deep links, history) from
  // re-committing the stale pending value.
  const committedTextRef = useRef(debouncedText);
  useEffect(() => {
    if (debouncedText === committedTextRef.current) {
      return;
    }
    committedTextRef.current = debouncedText;
    const trimmed = debouncedText.trim();
    if (trimmed === query || !isSearchable(trimmed)) {
      return;
    }
    onChange({ query: trimmed, sort, category, channel, dateFrom, dateTo });
  }, [debouncedText, query, sort, category, channel, dateFrom, dateTo, onChange]);

  // The channel filter would otherwise search on every keystroke; it commits
  // with the same pause as the phrase (`channel` is the committed value).
  const committedChannelRef = useRef(debouncedChannel);
  useEffect(() => {
    if (debouncedChannel === committedChannelRef.current) {
      return;
    }
    committedChannelRef.current = debouncedChannel;
    const trimmed = debouncedChannel.trim();
    if (trimmed === channel) {
      return;
    }
    onChange({
      query,
      sort,
      category,
      channel: trimmed,
      dateFrom,
      dateTo,
    });
  }, [debouncedChannel, channel, query, sort, category, dateFrom, dateTo, onChange]);

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
      channel: channelText.trim(),
      dateFrom,
      dateTo,
      ...patch,
    });
  };

  const handleClear = () => {
    setText('');
    commitWith({ query: '' });
  };

  const categoryOptions =
    category.length > 0 && !categories.includes(category)
      ? [...categories, category] // a URL may name a category the list does not (yet) know
      : categories;

  return (
    <div className="search-bar">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('search.placeholder')}
        className="search-input"
      />
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
      {channels.length > 0 && (
        <>
          <input
            type="text"
            list="channel-suggestions"
            value={channelText}
            onChange={(e) => setChannelText(e.target.value)}
            placeholder={t('search.channelPlaceholder')}
            className="channel-input"
            aria-label={t('search.channel')}
          />
          <datalist id="channel-suggestions">
            {channels.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </>
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
