import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorMessage } from './ErrorMessage';

describe('ErrorMessage', () => {
  it('renders the message with an alert role', () => {
    render(<ErrorMessage>Błąd: coś poszło nie tak</ErrorMessage>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Błąd: coś poszło nie tak');
  });

  it('renders children, not only text', () => {
    render(
      <ErrorMessage>
        <a href="/videos">wróć</a>
      </ErrorMessage>,
    );

    expect(screen.getByRole('link', { name: 'wróć' })).toBeInTheDocument();
  });

  it('marks the compact form variant', () => {
    render(<ErrorMessage compact>za krótki adres</ErrorMessage>);

    expect(screen.getByRole('alert')).toHaveClass('ui-error-message--compact');
  });
});
