import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('renders with the label as the accessible name', () => {
    render(<Checkbox checked={false} onChange={vi.fn()} label="tylko brakujące" />);

    const box = screen.getByRole('checkbox', { name: 'tylko brakujące' });
    expect(box).not.toBeChecked();
    expect(screen.getByText('tylko brakujące')).toBeInTheDocument();
  });

  it('reports the toggled state when the box is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Pobieraj napisy" />);

    await user.click(screen.getByRole('checkbox', { name: 'Pobieraj napisy' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles from a label click too (whole row is the label)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked onChange={onChange} label="Pobieraj komentarze" />);

    await user.click(screen.getByText('Pobieraj komentarze'));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not report changes when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Checkbox checked={false} onChange={onChange} label="wyłączone" disabled />);

    const box = screen.getByRole('checkbox', { name: 'wyłączone' });
    expect(box).toBeDisabled();
    await user.click(box);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an external class name', () => {
    const { container } = render(
      <Checkbox checked={false} onChange={vi.fn()} label="x" className="toolbar-checkbox" />,
    );

    expect(container.querySelector('.ui-checkbox.toolbar-checkbox')).not.toBeNull();
  });

  it('renders the styled box itself as the checkbox role (Radix root)', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={vi.fn()} label="x" />);

    const box = screen.getByRole('checkbox', { name: 'x' });
    expect(box.tagName).toBe('BUTTON');
    expect(box).toHaveClass('ui-checkbox-box');
    expect(box).toHaveAttribute('data-state', 'unchecked');

    rerender(<Checkbox checked onChange={vi.fn()} label="x" />);
    expect(box).toHaveAttribute('data-state', 'checked');
  });

  it('toggles with the space key when the box is focused', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Pobieraj napisy" />);

    const box = screen.getByRole('checkbox', { name: 'Pobieraj napisy' });
    box.focus();
    await user.keyboard(' ');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
