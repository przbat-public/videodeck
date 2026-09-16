import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { JSX, ReactNode } from 'react';

/**
 * Shared tooltip delay. 300ms reads as instant on a desktop app without
 * flashing a tooltip on every incidental hover.
 */
const TOOLTIP_DELAY_MS = 300;

interface TooltipProps {
  /** Tooltip text; a falsy label renders the children without a tooltip */
  label: string | undefined;
  /** The trigger element; must accept a ref and the Radix trigger props */
  children: ReactNode;
}

/**
 * Convenience wrapper around Radix Tooltip: trigger + content in one
 * element, self-contained (its own provider, so call sites and tests do
 * not need to mount one). The trigger is the child itself (`asChild`), so
 * the DOM stays unchanged until the tooltip opens.
 */
export function Tooltip({ label, children }: TooltipProps): JSX.Element {
  if (!label) {
    return <>{children}</>;
  }
  return (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={TOOLTIP_DELAY_MS}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="ui-tooltip-content" sideOffset={6} collisionPadding={8}>
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
