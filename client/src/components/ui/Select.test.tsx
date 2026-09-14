import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from './Select';

const options = (
  <>
    <option value="">Wszystkie kategorie</option>
    <option value="fpv">fpv</option>
    <option value="lego">lego</option>
  </>
);

describe('Select', () => {
  it('renders a native combobox with the aria-label as the name', () => {
    render(
      <Select value="" onChange={vi.fn()} aria-label="Kategoria">
        {options}
      </Select>
    );

    const combobox = screen.getByRole('combobox', { name: 'Kategoria' });
    expect(combobox).toHaveValue('');
    expect(combobox.querySelectorAll('option')).toHaveLength(3);
  });

  it('reports the chosen value', () => {
    const onChange = vi.fn();
    render(
      <Select value="" onChange={onChange} aria-label="Sort">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'b' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('does not report changes when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select value="a" onChange={onChange} disabled aria-label="Sort">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>
    );

    const combobox = screen.getByRole('combobox', { name: 'Sort' });
    expect(combobox).toBeDisabled();
    await user.selectOptions(combobox, 'b');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps external classes on the native select', () => {
    const { container } = render(
      <Select value="" onChange={vi.fn()} className="sort-select" aria-label="Sort">
        {options}
      </Select>
    );

    const combobox = container.querySelector('select.ui-select-native.sort-select');
    expect(combobox).not.toBeNull();
  });
});
