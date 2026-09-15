import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeSwitcher } from './ThemeSwitcher';

describe('ThemeSwitcher', () => {
  it('shows the current theme and reports changes', () => {
    const onThemeChange = vi.fn();
    render(<ThemeSwitcher theme="system" onThemeChange={onThemeChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Motyw' }));
    fireEvent.click(screen.getByRole('option', { name: 'Ciemny' }));

    expect(onThemeChange).toHaveBeenCalledWith('dark');
  });
});
