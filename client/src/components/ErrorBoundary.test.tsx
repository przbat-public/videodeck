import type { JSX } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

function Bomb(): JSX.Element {
  throw new Error('kaput');
}

function Healthy(): JSX.Element {
  return <p>wszystko gra</p>;
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Healthy />
      </ErrorBoundary>
    );

    expect(screen.getByText('wszystko gra')).toBeInTheDocument();
  });

  it('shows the fallback with the error message when a child throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      );
    } finally {
      consoleSpy.mockRestore();
    }

    expect(screen.getByText('Coś poszło nie tak')).toBeInTheDocument();
    expect(screen.getByText('kaput')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Odśwież stronę' })).toBeInTheDocument();
  });
});
