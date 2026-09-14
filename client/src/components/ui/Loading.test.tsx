import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Loading } from './Loading';

describe('Loading', () => {
  it('shows the default message with a status role', () => {
    render(<Loading />);

    expect(screen.getByRole('status')).toHaveTextContent('Ładowanie...');
  });

  it('shows a custom message', () => {
    render(<Loading message="Ładowanie filmu..." />);

    expect(screen.getByText('Ładowanie filmu...')).toBeInTheDocument();
  });
});
