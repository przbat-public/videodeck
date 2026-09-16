import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('shows the label on hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Podpowiedź">
        <button type="button">x</button>
      </Tooltip>,
    );

    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(screen.getByRole('button', { name: 'x' }));

    expect(await screen.findByRole('tooltip', { name: 'Podpowiedź' })).toBeInTheDocument();
  });

  it('shows the label on keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Podpowiedź">
        <button type="button">x</button>
      </Tooltip>,
    );

    await user.tab();

    expect(await screen.findByRole('tooltip', { name: 'Podpowiedź' })).toBeInTheDocument();
  });

  it('opens for a non-interactive trigger that is keyboard reachable', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Data">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the span is the Radix tooltip trigger; focus is the keyboard path to the info */}
        <span tabIndex={0}>wczoraj</span>
      </Tooltip>,
    );

    await user.tab();

    expect(await screen.findByRole('tooltip', { name: 'Data' })).toBeInTheDocument();
  });

  it('renders nothing extra when the label is empty', () => {
    const { container } = render(
      <Tooltip label={undefined}>
        <button type="button">x</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'x' })).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(container.querySelector('.ui-tooltip-content')).toBeNull();
  });
});
