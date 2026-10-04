import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * The dialog is a real `<dialog>` opened through `showModal()`, so the top
 * layer, the backdrop and the focus trap belong to the browser. jsdom has no
 * `<dialog>` implementation at all (see test/setup.ts), so what these tests
 * pin down is the contract around it: the element really goes modal, Escape
 * reaches the caller as a close, a click outside the panel leaves the form
 * alone, and the control that opened the dialog gets focus back. The browser
 * half of that (Escape closing a modal, the trap, the backdrop) is covered in
 * client/e2e/channel-console.spec.ts.
 */
function Harness({ onClose = vi.fn() }: { onClose?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(null);
  const close = (): void => {
    setOpen(false);
    onClose();
  };

  return (
    <div>
      <button
        type="button"
        onClick={(event) => {
          // The control the dialog hands focus back to is the one that was
          // clicked, exactly as the console's ⋯ trigger is
          setReturnFocus(event.currentTarget);
          setOpen(true);
        }}
      >
        Edytuj config.json
      </button>
      {open && (
        <Modal title="Konfiguracja folderu" onClose={close} returnFocus={returnFocus}>
          <Button onClick={close}>Anuluj</Button>
        </Modal>
      )}
    </div>
  );
}

describe('Modal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a modal dialog named by its heading', async () => {
    const user = userEvent.setup();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Edytuj config.json' }));

    expect(showModal).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'Konfiguracja folderu' });
    // `open` is the attribute the browser itself sets: it tells a modal dialog
    // from an element that only looks like one
    expect(dialog).toHaveAttribute('open');
  });

  it('reports a cancel (Escape) to the caller', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Edytuj config.json' }));
    // The browser turns Escape into a cancel event on the dialog; jsdom does
    // not, so the event is dispatched the way the browser would
    fireEvent(screen.getByRole('dialog'), new Event('cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the form open when the click lands on the backdrop', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Edytuj config.json' }));
    // A click outside the panel hits the dialog element itself: a half-filled
    // form must not lose its edits to a stray click
    await user.click(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes a dialog that has no control to hand focus back to', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function OpenedHarness(): React.JSX.Element | null {
      const [open, setOpen] = useState(true);
      const close = (): void => {
        setOpen(false);
        onClose();
      };
      return open ? (
        <Modal title="Konfiguracja folderu" onClose={close}>
          <Button onClick={close}>Anuluj</Button>
        </Modal>
      ) : null;
    }
    render(<OpenedHarness />);

    await user.click(screen.getByRole('button', { name: 'Anuluj' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hands focus back to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Edytuj config.json' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Anuluj' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
