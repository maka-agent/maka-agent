import { useLayoutEffect, useRef, useState } from 'react';
import { TextQuote, X } from './icons.js';
import { cn } from './utils.js';
import type { QuoteRef } from '@maka/core';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/**
 * Inline quoted-excerpt chip, shown inside the composer (removable) and inside
 * a sent user message (read-only). A single-line pill rather than a card: a
 * quote is a *reference*, so it should read as one token beside the message
 * instead of competing with it for vertical space.
 *
 * An excerpt too long for the pill stays clipped until the user asks for it —
 * clicking expands the chip in place to the full text. The model receives the
 * excerpt verbatim either way (formatTextWithInlineRefs); this is presentation
 * only. Expandability is measured, not guessed from a character count, so it
 * holds for CJK and latin alike.
 *
 * Keeping the chip on the sent message is deliberate — a quote the user can
 * see before sending but not afterwards makes the turn unauditable.
 */
export function QuoteRefChip(props: {
  quote: QuoteRef;
  onRemove?: () => void;
  className?: string;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLButtonElement>(null);
  const label = props.quote.label;
  const full = label ? `${label}: ${props.quote.text}` : props.quote.text;

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    setClipped(el.scrollWidth > el.clientWidth + 1);
  }, [expanded, props.quote.text, label]);

  const canExpand = clipped || expanded;
  return (
    <span
      className={cn(
        'maka-quote-chip inline-flex gap-1 bg-[var(--foreground-alpha-6)] ring-1 ring-inset ring-[color:var(--foreground-alpha-12)] pl-2',
        expanded
          ? 'w-full max-w-full items-start rounded-md py-1'
          : 'max-w-[15rem] items-center rounded-full py-0.5',
        props.onRemove ? 'pr-0.5' : 'pr-2',
        props.className,
      )}
      title={expanded ? undefined : full}
    >
      <TextQuote
        className={cn('h-3 w-3 shrink-0 text-muted-foreground', expanded && 'mt-0.5')}
        aria-hidden="true"
      />
      <button
        ref={textRef}
        type="button"
        {...(canExpand
          ? {
              onClick: () => setExpanded((open) => !open),
              'aria-expanded': expanded,
              'aria-label': expanded ? copy.quoteCollapseAriaLabel : copy.quoteExpandAriaLabel,
            }
          : { tabIndex: -1 })}
        className={cn(
          'min-w-0 flex-1 text-left text-xs text-foreground-secondary',
          expanded ? 'max-h-32 overflow-y-auto whitespace-pre-wrap break-words' : 'truncate',
        )}
      >
        {label ? <span className="text-muted-foreground">{label} </span> : null}
        {props.quote.text}
      </button>
      {props.onRemove && (
        <button
          type="button"
          onClick={props.onRemove}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--foreground-alpha-10)] hover:text-foreground transition"
          aria-label={copy.removeQuoteAriaLabel}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
