import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConsoleState } from '../utils/channelConsoleState';
import { DEFAULT_CHANNEL_CONSOLE_STATE } from '../utils/channelConsoleState';
import { ChannelToolbar } from './ChannelToolbar';

const counts = { all: 20, attention: 4, queue: 3, failed: 1 };

/**
 * The toolbar is controlled, so the test has to feed the state back the way
 * the page does; otherwise every keystroke reports only the character that
 * does not survive the re-render.
 */
function Harness({ onChange }: { onChange: (next: ChannelConsoleState) => void }): React.JSX.Element {
  const [state, setState] = useState(DEFAULT_CHANNEL_CONSOLE_STATE);
  return (
    <ChannelToolbar
      state={state}
      counts={counts}
      onChange={(next) => {
        setState(next);
        onChange(next);
      }}
    />
  );
}

const renderToolbar = () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  return { onChange };
};

const user = userEvent.setup();

describe('ChannelToolbar', () => {
  it('reports the typed phrase', async () => {
    const { onChange } = renderToolbar();

    await user.type(screen.getByRole('searchbox', { name: 'Szukaj kanału, kategorii lub ścieżki...' }), 'fpv');

    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_CHANNEL_CONSOLE_STATE, query: 'fpv' });
  });

  it('shows every chip with its count and marks the active one', () => {
    renderToolbar();

    expect(screen.getByRole('button', { name: 'Wszystkie (20)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Wymaga uwagi (4)' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'W kolejce (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Błędy (1)' })).toBeInTheDocument();
  });

  it('reports the chosen chip', async () => {
    const { onChange } = renderToolbar();

    await user.click(screen.getByRole('button', { name: 'Błędy (1)' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_CHANNEL_CONSOLE_STATE, filter: 'failed' });
  });

  it('reports the chosen sort', async () => {
    const { onChange } = renderToolbar();

    await user.click(screen.getByRole('combobox', { name: 'Sortuj' }));
    await user.click(await screen.findByRole('option', { name: 'Najwięcej niepobranych' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_CHANNEL_CONSOLE_STATE, sort: 'missing' });
  });
});
