import type { JSX, ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';

interface ModalProps {
  /** Accessible name of the dialog; rendered as its own heading */
  title: string;
  /** The dialog closed itself: Escape, or one of the panel's own buttons */
  onClose: () => void;
  /**
   * What takes focus once the dialog is gone. `<dialog>` restores focus to
   * whatever held it when `showModal()` ran, and that is the menu entry the
   * click came from, which is unmounted by the time the dialog closes. The
   * caller hands over the control that outlives it instead.
   */
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}

/**
 * The app's modal primitive: a real `<dialog>` opened with `showModal()`, so
 * the browser owns the top layer, the backdrop, the focus trap and Escape
 * (DESIGN.md section 6). The panel is a floating surface like the Select and
 * Menu popovers, styled by `.ui-modal` in App.css.
 *
 * A mounted modal is an open one: the caller renders it while it wants it on
 * screen and takes it down to close it, so one owner holds the open state.
 * Escape does not close the element behind React's back either; the cancel
 * event is sent to the caller instead, which keeps a half-filled form intact
 * until the caller decides.
 */
export function Modal({ title, onClose, returnFocus = null, children }: ModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnFocusRef = useRef(returnFocus);

  useEffect(() => {
    returnFocusRef.current = returnFocus;
  }, [returnFocus]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    return () => {
      // Closing before the node leaves the document is what tells the browser
      // to move focus off the dialog, and the target is then ours to choose.
      dialog.close();
      returnFocusRef.current?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="ui-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="ui-modal-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
