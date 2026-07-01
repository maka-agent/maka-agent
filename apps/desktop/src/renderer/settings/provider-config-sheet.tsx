import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from '@maka/ui/icons';
import { Button, useModalA11y } from '@maka/ui';

/**
 * Modal overlay + sheet for the provider config sub-flow. Wraps
 * `useModalA11y` so:
 *  - Tab/Shift+Tab cycles focus inside the sheet (no leak to sidebar)
 *  - Initial focus lands on the first interactive element
 *  - Esc closes the sheet (matches the overlay click-to-close)
 *  - Focus restoration to the previously-focused element on close
 *
 * Without this hook the sheet had `role="dialog"` + `aria-modal="true"`
 * but no actual focus trap or keyboard-dismiss path — a screen reader
 * user couldn't navigate the sheet predictably.
 */
export function ProviderConfigSheetOverlay(props: { onClose(): void; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, props.onClose);
  useProviderSheetBackgroundInert(dialogRef);
  return (
    <div className="providerConfigOverlay" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={dialogRef as RefObject<HTMLDivElement>}
        className="providerConfigSheet"
        role="dialog"
        aria-modal="true"
        aria-label="模型供应商配置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          className="providerConfigSheetClose"
          aria-label="关闭模型配置"
          onClick={props.onClose}
        >
          <X strokeWidth={1.75} aria-hidden="true" />
        </Button>
        {props.children}
      </section>
    </div>
  );
}

export function useProviderSheetBackgroundInert(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const surface = dialog.closest('.settingsSurface');
    if (!(surface instanceof HTMLElement)) return;

    const changed: Array<{
      element: HTMLElement;
      ariaHidden: string | null;
      inert: boolean;
      marker: string | null;
    }> = [];
    let current: HTMLElement | null = dialog;
    while (current && current !== surface) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === current || sibling.contains(dialog)) continue;
        changed.push({
          element: sibling,
          ariaHidden: sibling.getAttribute('aria-hidden'),
          inert: sibling.inert,
          marker: sibling.getAttribute('data-provider-sheet-background-hidden'),
        });
        sibling.setAttribute('aria-hidden', 'true');
        sibling.inert = true;
        sibling.setAttribute('data-provider-sheet-background-hidden', 'true');
      }
      current = parent;
    }

    return () => {
      for (const item of changed.reverse()) {
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
        else item.element.setAttribute('aria-hidden', item.ariaHidden);
        item.element.inert = item.inert;
        if (item.marker === null) item.element.removeAttribute('data-provider-sheet-background-hidden');
        else item.element.setAttribute('data-provider-sheet-background-hidden', item.marker);
      }
    };
  }, [dialogRef]);
}
