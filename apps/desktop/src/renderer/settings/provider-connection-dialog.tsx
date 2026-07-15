import { useRef, type ReactNode } from 'react';
import type { ProviderType } from '@maka/core';
import { DialogContent, DialogHeader, DialogRoot } from '@maka/ui';
import { ProviderLogo } from './provider-display';

export function ProviderConnectionDialog(props: {
  title: string;
  subtitle: string;
  providerType: ProviderType;
  onClose(): void;
  finalFocus?(): HTMLElement | null;
  children: ReactNode;
}) {
  const titleId = `provider-connection-dialog-${props.providerType}`;
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="maka-modal providerConnectionDialog"
        aria-labelledby={titleId}
        initialFocus={() => bodyRef.current?.querySelector<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? true}
        finalFocus={props.finalFocus}
        showClose={false}
      >
        <DialogHeader
          icon={<ProviderLogo type={props.providerType} compact />}
          title={props.title}
          titleId={titleId}
          subtitle={props.subtitle}
          onClose={props.onClose}
        />
        <div ref={bodyRef} className="providerConnectionDialogBody">{props.children}</div>
      </DialogContent>
    </DialogRoot>
  );
}
