import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders its children and fires the handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Pobierz</Button>);

    const button = screen.getByRole('button', { name: 'Pobierz' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Czekaj
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Czekaj' });
    expect(button).toBeDisabled();
    await user.click(button);

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

  it('supports the small size and extra classes', () => {
    render(
      <Button size="small" className="extra">
        x
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'x' });
    expect(button).toHaveClass('ui-button--small', 'extra');
    expect(button).not.toHaveAttribute('title');
  });

  it('forwards a ref to the DOM button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>x</Button>);

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'x' }));
  });
});
