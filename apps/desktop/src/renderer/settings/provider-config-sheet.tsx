import { useLayoutEffect, useState, type ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';

/**
 * Nested dialog that slides in from the right of the settings surface.
 *
 * Routes OAuth login dialogs (ClaudeSubscriptionModal and
 * SubscriptionLoginModal) through Base UI Dialog so
 * focus trap, Esc, and aria-hidden on the settings nav come from Base UI's
 * modal layer instead of the hand-written `useModalA11y` + the
 * `useProviderSheetBackgroundInert` DOM walker (#520 PR7 commit 3).
 *
 * Two Base UI specifics that make the nested side-sheet work:
 *
 * - `Dialog.Portal container` is the `.settingsSurface` element, so the
 *   backdrop + popup render INSIDE settings — preserving the nested visual
 *   (rounded corners aligned to the settings modal, scrim only covers the
 *   surface, not the whole viewport).
 * - `Dialog.Backdrop forceRender` because Base UI skips the nested backdrop
 *   by default (designed for center-on-center modals where a double scrim is
 *   noise). Provider sheets are side panels that explicitly want the scrim
 *   over the settings nav/list.
 *
 * Verified via CDP probe: with `forceRender`, the nested popup gets
 * `data-nested`, the settings nav/main get `aria-hidden="true"`, and the
 * backdrop covers the surface (pointer to it triggers Base UI's dismiss).
 */
export function ProviderSheet(props: {
  onClose(): void;
  ariaLabel?: string;
  ariaLabelledby?: string;
  dataSubscription?: string;
  children: ReactNode;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  // `.settingsSurface` is a singleton: SettingsModal is conditional-mounted by
  // the shell (`{settingsOpen && <SettingsModal/>}`), so at most one surface
  // exists in the DOM. If a second surface ever appears, replace this global
  // query with an owner-scoped ref passed down from the surface owner.
  useLayoutEffect(() => {
    setContainer(document.querySelector<HTMLElement>('.settingsSurface'));
  }, []);
  if (!container) return null;
  return (
    <BaseDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <BaseDialog.Portal container={container}>
        <BaseDialog.Backdrop className="providerConfigOverlay" forceRender data-slot="provider-backdrop" />
        <BaseDialog.Popup
          className="providerConfigSheet"
          data-slot="provider-sheet"
          aria-label={props.ariaLabel}
          aria-labelledby={props.ariaLabelledby}
          data-subscription={props.dataSubscription}
        >
          {props.children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
