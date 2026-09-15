import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

describe('LanguageSwitcher', () => {
  afterEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage('pl');
  });

  it('marks Polish as active by default and switches to English on click', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    const pl = screen.getByRole('button', { name: 'PL' });
    const en = screen.getByRole('button', { name: 'EN' });
    expect(pl).toHaveAttribute('aria-pressed', 'true');
    expect(en).toHaveAttribute('aria-pressed', 'false');

    await user.click(en);

    expect(i18n.resolvedLanguage).toBe('en');
    expect(en).toHaveAttribute('aria-pressed', 'true');
    expect(pl).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('i18nextLng')).toBe('en');
  });

  it('keeps the choice in localStorage across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<LanguageSwitcher />);
    await user.click(screen.getByRole('button', { name: 'EN' }));
    unmount();

    render(<LanguageSwitcher />);
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
  });
});
