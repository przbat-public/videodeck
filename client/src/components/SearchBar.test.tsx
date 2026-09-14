import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act, useState } from 'react';
import userEvent from '@testing-library/user-event';
import type { SearchState } from '../utils/searchUrlState';
import { DEFAULT_SEARCH_STATE, SORT_OPTIONS } from '../utils/searchUrlState';
import SearchBar from './SearchBar';

const CATEGORIES = ['fpv', 'lego', 'psychology'];

const input = () => screen.getByPlaceholderText('Szukaj filmów po opisie...');
const sortSelect = () => screen.getByRole('combobox', { name: 'Sort' });
const categorySelect = () => screen.getByRole('combobox', { name: 'Kategoria' });
const clearButton = () => screen.getByRole('button', { name: 'Clear' });

const setupUser = () => userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

const flushTimers = async () => {
  await act(async () => {
    vi.runAllTimers();
  });
};

/** The bar with a parent that ignores commits — props change only when the test says so */
function renderBar(
  state: Partial<SearchState> = {},
  categories: string[] = CATEGORIES
): { onChange: Mock<(next: SearchState) => void>; update: (patch: Partial<SearchState>) => void } {
  const onChange = vi.fn<(next: SearchState) => void>();
  let current: SearchState = { ...DEFAULT_SEARCH_STATE, ...state };
  const element = () => <SearchBar {...current} categories={categories} onChange={onChange} />;
  const { rerender } = render(element());
  return {
    onChange,
    update: (patch) => {
      current = { ...current, ...patch };
      rerender(element());
    },
  };
}

/** The bar under a parent that behaves like the page: every commit comes back as props */
function Parent({
  initial,
  categories,
  onChange,
}: {
  initial: SearchState;
  categories: string[];
  onChange: (next: SearchState) => void;
}) {
  const [state, setState] = useState(initial);
  return (
    <SearchBar
      {...state}
      categories={categories}
      onChange={(next) => {
        onChange(next);
        setState(next);
      }}
    />
  );
}

function renderWithParent(
  state: Partial<SearchState> = {},
  categories: string[] = CATEGORIES
): { onChange: Mock<(next: SearchState) => void> } {
  const onChange = vi.fn<(next: SearchState) => void>();
  render(
    <Parent
      initial={{ ...DEFAULT_SEARCH_STATE, ...state }}
      categories={categories}
      onChange={onChange}
    />
  );
  return { onChange };
}

describe('SearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('rendering the committed state', () => {
    it('shows the query, sort and category it is given', () => {
      renderBar({ query: 'robot arm', sort: 'views-desc', category: 'lego' });

      expect(input()).toHaveValue('robot arm');
      expect(sortSelect()).toHaveValue('views-desc');
      expect(categorySelect()).toHaveValue('lego');
      expect(clearButton()).toBeInTheDocument();
    });

    it('offers every sort option in order', () => {
      renderBar();

      const options = Array.from(sortSelect().querySelectorAll('option'));
      expect(options.map((option) => option.value)).toEqual(SORT_OPTIONS.map((o) => o.value));
      expect(options.map((option) => option.textContent)).toEqual(SORT_OPTIONS.map((o) => o.label));
    });

    it('hides the category filter when there is nothing to pick from', () => {
      renderBar({}, []);

      expect(screen.queryByRole('combobox', { name: 'Kategoria' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    });

    it('lists "Wszystkie kategorie" first, then the categories it is given', () => {
      renderBar();

      const options = Array.from(categorySelect().querySelectorAll('option'));
      expect(options.map((option) => option.value)).toEqual(['', ...CATEGORIES]);
      expect(options[0]?.textContent).toBe('Wszystkie kategorie');
    });

    it('keeps a category from the URL selectable even when the server list lacks it', () => {
      renderBar({ category: 'archive' }, ['fpv']);

      expect(categorySelect()).toHaveValue('archive');
      expect(Array.from(categorySelect().querySelectorAll('option')).map((o) => o.value)).toEqual([
        '',
        'fpv',
        'archive',
      ]);
    });

    it('shows the filter for a URL category even before any categories have loaded', () => {
      renderBar({ category: 'lego' }, []);

      expect(categorySelect()).toHaveValue('lego');
    });
  });

  describe('committing the typed phrase', () => {
    it('does not commit on mount, whatever it was given', async () => {
      const { onChange } = renderBar({ query: 'robot', sort: 'likes-asc', category: 'lego' });

      await flushTimers();

      expect(onChange).not.toHaveBeenCalled();
    });

    it('commits a phrase of three or more characters once the typing pauses', async () => {
      const user = setupUser();
      const { onChange } = renderBar({ sort: 'views-desc', category: 'fpv' });

      await act(() => user.type(input(), 'abc'));
      await advance(299);
      expect(onChange).not.toHaveBeenCalled();

      await advance(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ query: 'abc', sort: 'views-desc', category: 'fpv' });
    });

    it('never commits one or two characters', async () => {
      const user = setupUser();
      const { onChange } = renderBar();

      await act(() => user.type(input(), 'ab'));
      await flushTimers();

      expect(onChange).not.toHaveBeenCalled();
      expect(input()).toHaveValue('ab');
    });

    it('restarts the pause with every keystroke and commits the final phrase only', async () => {
      const user = setupUser();
      const { onChange } = renderBar();

      await act(() => user.type(input(), 'abc'));
      await advance(200);
      await act(() => user.type(input(), 'd'));
      await advance(200);
      expect(onChange).not.toHaveBeenCalled();

      await advance(100);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SEARCH_STATE, query: 'abcd' });
    });

    it('trims the phrase it commits', async () => {
      const user = setupUser();
      const { onChange } = renderBar();

      await act(() => user.type(input(), '  robot  '));
      await flushTimers();

      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SEARCH_STATE, query: 'robot' });
    });

    it('does not treat whitespace alone as a new search', async () => {
      const user = setupUser();
      const { onChange } = renderBar();

      await act(() => user.type(input(), '   '));
      await flushTimers();

      expect(onChange).not.toHaveBeenCalled();
    });

    it('commits the empty phrase when the text is deleted', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent({ query: 'robot', category: 'lego' });

      await act(() => user.clear(input()));
      expect(onChange).not.toHaveBeenCalled();

      await advance(300);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ query: '', sort: 'date-desc', category: 'lego' });
    });

    it('does not commit again when the parent echoes the phrase back', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent();

      await act(() => user.type(input(), 'robot'));
      await flushTimers();
      await flushTimers();

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('leaves a trailing space alone when its own commit comes back', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent();

      await act(() => user.type(input(), 'robot '));
      await flushTimers();

      expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SEARCH_STATE, query: 'robot' });
      expect(input()).toHaveValue('robot ');
    });
  });

  describe('following the committed state from outside', () => {
    it('shows a query that arrives from the URL without committing it back', async () => {
      const { onChange, update } = renderBar({ query: 'old' });

      update({ query: 'brand new' });
      await flushTimers();

      expect(input()).toHaveValue('brand new');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('replaces a half-typed phrase when the committed query changes underneath it', async () => {
      const user = setupUser();
      const { onChange, update } = renderBar({ query: 'robot' });

      await act(() => user.clear(input()));
      await act(() => user.type(input(), 'ar'));
      expect(input()).toHaveValue('ar');

      update({ query: 'drone' });
      await flushTimers();

      expect(input()).toHaveValue('drone');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('updates the selects when sort and category change from outside', () => {
      const { update } = renderBar();

      update({ sort: 'likes-desc', category: 'psychology' });

      expect(sortSelect()).toHaveValue('likes-desc');
      expect(categorySelect()).toHaveValue('psychology');
    });
  });

  describe('selects and the clear button', () => {
    it('commits a sort change at once, keeping the committed query', async () => {
      const user = setupUser();
      const { onChange } = renderBar({ query: 'robot', category: 'lego' });

      await act(() => user.selectOptions(sortSelect(), 'views-desc'));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({
        query: 'robot',
        sort: 'views-desc',
        category: 'lego',
      });
    });

    it('commits a category change at once and "Wszystkie kategorie" as an empty category', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent({ query: 'robot' });

      await act(() => user.selectOptions(categorySelect(), 'psychology'));
      expect(onChange).toHaveBeenLastCalledWith({
        query: 'robot',
        sort: 'date-desc',
        category: 'psychology',
      });

      await act(() => user.selectOptions(categorySelect(), ''));
      expect(onChange).toHaveBeenLastCalledWith({
        query: 'robot',
        sort: 'date-desc',
        category: '',
      });
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('takes a searchable phrase along with a sort change instead of waiting for the pause', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent();

      await act(() => user.type(input(), 'lego'));
      await act(() => user.selectOptions(sortSelect(), 'likes-desc'));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ query: 'lego', sort: 'likes-desc', category: '' });

      await flushTimers();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('keeps the committed query when the phrase is still too short to search', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent({ query: 'robot' });

      await act(() => user.clear(input()));
      await act(() => user.type(input(), 'ro'));
      await act(() => user.selectOptions(categorySelect(), 'fpv'));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ query: 'robot', sort: 'date-desc', category: 'fpv' });
      expect(input()).toHaveValue('ro');

      await flushTimers();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('Clear empties the input and commits the empty phrase at once, exactly once', async () => {
      const user = setupUser();
      const { onChange } = renderWithParent({ query: 'robot', sort: 'views-asc', category: 'fpv' });

      await act(() => user.click(clearButton()));

      expect(input()).toHaveValue('');
      expect(onChange).toHaveBeenCalledWith({ query: '', sort: 'views-asc', category: 'fpv' });
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

      await flushTimers();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('shows Clear for text that has not been committed yet', async () => {
      const user = setupUser();
      renderBar();

      await act(() => user.type(input(), 'a'));

      expect(clearButton()).toBeInTheDocument();
    });
  });
});
