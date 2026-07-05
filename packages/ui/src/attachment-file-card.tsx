import { X } from './icons.js';
import { AttachmentKindIcon } from './attachment-kinds.js';
import { formatBytes } from './tool-activity/preview-utils.js';
import { cn } from './utils.js';
import type { AttachmentRef } from '@maka/core';

/**
 * File attachment card shown inside the composer (removable) and inside a
 * sent user message (read-only). Follows the neutral-file-card pattern used
 * by ChatGPT/Claude/Creative-Tim's ai-file-attachment block: a neutral
 * surface, an icon tile, a truncated filename, and a mono file size.
 * Images are handled separately by AttachmentImage (thumbnail + lightbox);
 * this card is for non-image kinds (pdf/doc/code/other).
 */
export function AttachmentFileCard(props: {
  name: string;
  kind: AttachmentRef['kind'];
  size?: number;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg bg-foreground/[0.06] ring-1 ring-inset ring-foreground/[0.12] p-2 w-[200px] max-w-full',
        props.className,
      )}
    >
      <span className="h-9 w-9 shrink-0 rounded-md bg-foreground/[0.10] grid place-items-center text-foreground-secondary">
        <AttachmentKindIcon kind={props.kind} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-medium text-foreground">{props.name}</span>
        {props.size !== undefined && (
          <span className="block truncate text-[11px] font-mono tabular-nums text-muted-foreground mt-0.5">
            {formatBytes(props.size)}
          </span>
        )}
      </span>
      {props.onRemove && (
        <button
          type="button"
          onClick={props.onRemove}
          className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition"
          aria-label={`移除 ${props.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}