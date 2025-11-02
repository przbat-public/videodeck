import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import SearchBar from './SearchBar';

describe('SearchBar', () => {
  it('should render search input and button', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    expect(screen.getByPlaceholderText('Search videos by description...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('should call onSearch when form is submitted', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    const button = screen.getByRole('button', { name: /search/i });

    await act(async () => {
      await user.type(input, 'test query');
    });
    await act(async () => {
      await user.click(button);
    });

    await waitFor(() => {
      expect(mockOnSearch).toHaveBeenCalledWith('test query', 'date-desc');
    });
  });

  it('should call onSearch when Enter is pressed', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await act(async () => {
      await user.type(input, 'test query{Enter}');
    });

    await waitFor(() => {
      expect(mockOnSearch).toHaveBeenCalledWith('test query', 'date-desc');
    });
  });

  it('should call onSearch with selected sort option when sort changes', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    const select = screen.getByRole('combobox');

    await act(async () => {
      await user.type(input, 'test');
    });
    await act(async () => {
      await user.selectOptions(select, 'views-desc');
    });

    await waitFor(() => {
      expect(mockOnSearch).toHaveBeenCalledWith('test', 'views-desc');
    });
  });

  it('should show clear button when query is not empty', async () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'test' } });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
    });
  });

  it('should clear input and call onSearch with empty string when clear is clicked', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await act(async () => {
      await user.type(input, 'test');
    });
    
    const clearButton = screen.getByRole('button', { name: /clear/i });
    await act(async () => {
      await user.click(clearButton);
    });

    await waitFor(() => {
      expect(input).toHaveValue('');
      expect(mockOnSearch).toHaveBeenCalledWith('', 'date-desc');
    });
  });

  it('should disable inputs when loading', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} loading={true} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    const button = screen.getByRole('button', { name: /searching/i });
    const select = screen.getByRole('combobox');

    expect(input).toBeDisabled();
    expect(button).toBeDisabled();
    expect(select).toBeDisabled();
  });

  it('should show "Searching..." text when loading', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} loading={true} />);

    expect(screen.getByRole('button', { name: /searching/i })).toBeInTheDocument();
  });
});

