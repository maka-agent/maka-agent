import type { ReactNode } from 'react';
import type { Search } from './icons.js';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './primitives/empty.js';
import { Button as UiButton, cn } from './ui.js';

type EmptyStateIcon = typeof Search;

/**
 * PR-EMPTY-STATE-COMPONENT-0: shared empty-state container. Folds the
 * 4 visual duplicates (skills empty / sessions empty / module fallbacks /
 * plan reminders empty) into a single declaration so the next empty
 * surface lands consistent by default and the icon-sizing /
 * paragraph-spacing / CTA-placement decisions only live in one
 * place. The `.maka-empty-state*` CSS family is unchanged.
 *
 * Body accepts `ReactNode` so callers can keep inline `<code>` for
 * the skills install instructions; CTAs are rendered as the canonical
 * `.maka-button.maka-empty-state-cta` so we never grow a competing
 * pile of "empty-state action variants".
 */
interface EmptyStateProps {
  Icon: EmptyStateIcon;
  title: string;
  body: ReactNode;
  cta?: { label: string; onClick: () => void; disabled?: boolean };
  secondaryCta?: { label: string; onClick: () => void; disabled?: boolean };
  /** Optional extra class on the container (e.g. `maka-plan-empty`). */
  extraClassName?: string;
  /** Optional `data-empty-view` passthrough for visual-smoke selectors. */
  dataEmptyView?: string;
}

export function EmptyState(props: EmptyStateProps) {
  const className = cn(
    'maka-empty-state rounded-md border-border bg-card/70 p-8 text-card-foreground shadow-maka-panel',
    props.extraClassName,
  );
  return (
    <Empty className={className} data-empty-view={props.dataEmptyView}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="maka-empty-state-media">
          <props.Icon className="maka-empty-state-icon size-6 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle className="maka-empty-state-title">{props.title}</EmptyTitle>
        <EmptyDescription className="maka-empty-state-body">{props.body}</EmptyDescription>
      </EmptyHeader>
      {(props.cta || props.secondaryCta) && (
        <EmptyContent className="maka-empty-state-actions mt-0">
          {props.cta && (
            <UiButton
              className="maka-button maka-empty-state-cta"
              type="button"
              onClick={props.cta.onClick}
              disabled={props.cta.disabled}
            >
              {props.cta.label}
            </UiButton>
          )}
          {props.secondaryCta && (
            <UiButton
              variant="ghost"
              className="maka-button maka-empty-state-cta"
              type="button"
              onClick={props.secondaryCta.onClick}
              disabled={props.secondaryCta.disabled}
            >
              {props.secondaryCta.label}
            </UiButton>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}
