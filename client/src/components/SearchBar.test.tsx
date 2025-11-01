import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchBar from './SearchBar';

describe('SearchBar', () => {
  it('should render search input and button', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    expect(screen.getByPlaceholderText('Search videos by description...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });

  it('should call onSearch when form is submitted', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    const button = screen.getByRole('button', { name: /search/i });

    await user.type(input, 'test query');
    await user.click(button);

    expect(mockOnSearch).toHaveBeenCalledWith('test query');
  });

  it('should call onSearch when Enter is pressed', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await user.type(input, 'test query{Enter}');

    expect(mockOnSearch).toHaveBeenCalledWith('test query');
  });

  it('should show clear button when query is not empty', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    fireEvent.change(input, { target: { value: 'test' } });

    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('should clear input and call onSearch with empty string when clear is clicked', async () => {
    const user = userEvent.setup();
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    await user.type(input, 'test');
    
    const clearButton = screen.getByRole('button', { name: /clear/i });
    await user.click(clearButton);

    expect(input).toHaveValue('');
    expect(mockOnSearch).toHaveBeenCalledWith('');
  });

  it('should disable inputs when loading', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} loading={true} />);

    const input = screen.getByPlaceholderText('Search videos by description...');
    const button = screen.getByRole('button', { name: /searching/i });

    expect(input).toBeDisabled();
    expect(button).toBeDisabled();
  });

  it('should show "Searching..." text when loading', () => {
    const mockOnSearch = vi.fn();
    render(<SearchBar onSearch={mockOnSearch} loading={true} />);

    expect(screen.getByRole('button', { name: /searching/i })).toBeInTheDocument();
  });
});

