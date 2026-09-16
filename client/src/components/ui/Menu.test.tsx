import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './Menu';

const user = userEvent.setup();

function renderMenu(
  onSelect: () => void,
  onCheckedChange: (checked: boolean) => void,
  checked = false,
): ReturnType<typeof render> {
  return render(
    <Menu>
      <MenuTrigger aria-label="App menu">
        <span>gear</span>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Section</MenuLabel>
        <MenuItem onSelect={onSelect}>Plain item</MenuItem>
        <MenuCheckboxItem checked={checked} onCheckedChange={onCheckedChange}>
          Toggle
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem active>Active item</MenuItem>
      </MenuContent>
    </Menu>,
  );
}

describe('ui/Menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the menu from the trigger and runs the picked item', async () => {
    const onSelect = vi.fn();
    renderMenu(onSelect, vi.fn());

    await user.click(screen.getByRole('button', { name: 'App menu' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Section')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Plain item' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('toggles a checkbox item without closing the menu', async () => {
    const onCheckedChange = vi.fn();
    renderMenu(vi.fn(), onCheckedChange);

    await user.click(screen.getByRole('button', { name: 'App menu' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Toggle' }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('marks the active item with an aria-hidden check', async () => {
    renderMenu(vi.fn(), vi.fn());

    await user.click(screen.getByRole('button', { name: 'App menu' }));

    const active = await screen.findByRole('menuitem', { name: 'Active item' });
    const indicator = active.querySelector('.ui-menu-item-indicator');
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('aria-hidden')).toBe('true');
  });
});
