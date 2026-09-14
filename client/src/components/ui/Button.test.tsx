import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders its children and fires the handler', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Pobierz</Button>);

    const button = screen.getByRole('button', { name: 'Pobierz' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Czekaj
      </Button>
    );

    const button = screen.getByRole('button', { name: 'Czekaj' });
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it.each([
    ['neutral', 'ui-button--neutral'],
    ['primary', 'ui-button--primary'],
    ['success', 'ui-button--success'],
    ['danger', 'ui-button--danger'],
  ] as const)('applies the %s variant class', (variant, expectedClass) => {
    render(<Button variant={variant}>x</Button>);

    expect(screen.getByRole('button', { name: 'x' })).toHaveClass(expectedClass);
  });

  it('supports the small size, a title and extra classes', () => {
    render(
      <Button size="small" title="Podpowiedź" className="extra">
        x
      </Button>
    );

    const button = screen.getByRole('button', { name: 'x' });
    expect(button).toHaveClass('ui-button--small', 'extra');
    expect(button).toHaveAttribute('title', 'Podpowiedź');
  });
});
