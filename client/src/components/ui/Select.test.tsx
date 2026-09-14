import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from './Select';

const items = [
  { value: '', label: 'Wszystkie kategorie' },
  { value: 'fpv', label: 'fpv' },
  { value: 'lego', label: 'lego' },
];

describe('Select', () => {
  it('renders a combobox showing the selected label', () => {
    render(<Select value="fpv" onChange={vi.fn()} aria-label="Kategoria" items={items} />);

    const combobox = screen.getByRole('combobox', { name: 'Kategoria' });
    expect(combobox).toHaveTextContent('fpv');
    // the list is not mounted until the trigger is opened
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('maps the empty value to the "none" option and back', () => {
    render(<Select value="" onChange={vi.fn()} aria-label="Kategoria" items={items} />);

    expect(screen.getByRole('combobox', { name: 'Kategoria' })).toHaveTextContent(
      'Wszystkie kategorie'
    );
  });

  it('opens on click and reports the chosen option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="fpv" onChange={onChange} aria-label="Kategoria" items={items} />);

    await user.click(screen.getByRole('combobox', { name: 'Kategoria' }));
    await user.click(await screen.findByRole('option', { name: 'lego' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('lego');
  });

  it('reports "" when the "none" option is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="fpv" onChange={onChange} aria-label="Kategoria" items={items} />);

    await user.click(screen.getByRole('combobox', { name: 'Kategoria' }));
    await user.click(await screen.findByRole('option', { name: 'Wszystkie kategorie' }));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('does not open and reports nothing when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select value="fpv" onChange={onChange} disabled aria-label="Kategoria" items={items} />
    );

    const combobox = screen.getByRole('combobox', { name: 'Kategoria' });
    expect(combobox).toBeDisabled();
    await user.click(combobox);

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes after picking and keeps external classes on the trigger', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        value="fpv"
        onChange={onChange}
        className="sort-select"
        aria-label="Sort"
        items={items}
      />
    );

    const combobox = screen.getByRole('combobox', { name: 'Sort' });
    expect(combobox.className).toContain('sort-select');

    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: 'lego' }));

    expect(onChange).toHaveBeenCalledWith('lego');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('opens via a plain click event (no pointer event needed in jsdom)', () => {
    render(<Select value="" onChange={vi.fn()} aria-label="Sort" items={items} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Sort' }));

    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});
