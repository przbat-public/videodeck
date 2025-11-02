import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import SearchBar from './SearchBar';

describe('SearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should render search input and sort select', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    expect(screen.getByPlaceholderText('Search videos by description...')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /search/i })).not.toBeInTheDocument();
  });

  it('should call onSearch automatically when query has at least 3 characters', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    
    await user.type(input, 'abc');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledWith('abc', 'date-desc');
  });

  it('should not call onSearch when query has less than 3 characters', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    
    await user.type(input, 'ab');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).not.toHaveBeenCalled();
  });

  it('should debounce search calls when typing', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    
    await user.type(input, 'abc');

    // Nie powinno jeszcze wywołać wyszukiwania
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    
    expect(mockOnSearch).not.toHaveBeenCalled();

    // Po pełnym czasie debounce powinno wywołać
    await act(async () => {
      vi.advanceTimersByTime(200);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledTimes(1);
    expect(mockOnSearch).toHaveBeenCalledWith('abc', 'date-desc');
  });

  it('should call onSearch with selected sort option when sort changes', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    const select = screen.getByRole('combobox');

    // Wpisz zapytanie (min 3 znaki)
    await user.type(input, 'test');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledWith('test', 'date-desc');

    mockOnSearch.mockClear();

    // Zmień sortowanie
    await user.selectOptions(select, 'views-desc');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledWith('test', 'views-desc');
  });

  it('should show clear button when query is not empty', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await user.type(input, 'test');

    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('should clear input and call onSearch with empty string when clear is clicked', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await user.type(input, 'test');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    const clearButton = screen.getByRole('button', { name: /clear/i });
    await user.click(clearButton);

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(input).toHaveValue('');
    expect(mockOnSearch).toHaveBeenCalledWith('', 'date-desc');
  });

  it('should call onSearch with empty string when query is cleared to empty', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    
    // Wpisz zapytanie
    await user.type(input, 'test query');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledWith('test query', 'date-desc');

    mockOnSearch.mockClear();

    // Wyczyść zapytanie
    await user.clear(input);

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledWith('', 'date-desc');
  });

  it('should trim whitespace from query before searching', async () => {
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    
    await user.type(input, '  abc  ');

    await act(async () => {
      vi.advanceTimersByTime(300);
      vi.runAllTimers();
    });

    expect(mockOnSearch).toHaveBeenCalledWith('abc', 'date-desc');
  });
});

