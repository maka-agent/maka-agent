import { Container, type Component, type Terminal } from '@earendil-works/pi-tui';
import {
  renderMakaPiStatusLine,
  renderMakaPiTranscriptSource,
  windowTranscriptLines,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
  type RenderedTranscript,
  type TranscriptLineOwner,
} from './pi-transcript.js';

export class MakaTranscriptComponent implements Component {
  constructor(
    private readonly state: MakaPiTranscriptState,
    private readonly metadata: () => MakaPiTranscriptMetadata,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderSource(width).lines;
  }

  renderSource(width: number): RenderedTranscript {
    return renderMakaPiTranscriptSource(this.state, this.metadata(), width);
  }
}

export class MakaStatusLineComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiStatusLine(this.metadata(), width)];
  }
}

/**
 * Row of the line the scroll anchor points at in a freshly rendered transcript,
 * or -1 when the anchored entry is gone entirely (e.g. compaction replaced the
 * transcript). If the entry survives but its block shrank past the anchored row,
 * fall back to the entry's last remaining row so the viewport stays on that
 * entry instead of jumping.
 */
function findAnchorRow(owners: readonly (TranscriptLineOwner | null)[], anchor: TranscriptLineOwner): number {
  let lastRowOfEntry = -1;
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    if (!owner || owner.entry !== anchor.entry) continue;
    if (owner.row === anchor.row) return i;
    lastRowOfEntry = i; // rows are emitted in order, so this tracks the max seen
  }
  return lastRowOfEntry;
}

/** The owner of the first content line at or after `start` (skipping spacers). */
function anchorOwnerAt(owners: readonly (TranscriptLineOwner | null)[], start: number): TranscriptLineOwner | null {
  for (let i = Math.max(0, start); i < owners.length; i++) {
    if (owners[i]) return owners[i];
  }
  for (let i = Math.min(start, owners.length) - 1; i >= 0; i--) {
    if (owners[i]) return owners[i];
  }
  return null;
}

export class MakaPiLayoutComponent extends Container {
  // Scroll position as lines hidden below the viewport bottom; 0 = following the
  // live tail. `followTail` re-pins to the bottom as new output streams in, so a
  // user reading history is only ever moved by an explicit scroll, never by the
  // agent's next line.
  private scrollOffset = 0;
  private followTail = true;
  private lastTotalLines = 0;
  private lastViewportRows = 0;
  private lastWidth = 0;
  // The content the top of the viewport is pinned to while scrolled. Anchoring to
  // a piece of content (an entry + row) rather than a line offset keeps the
  // reader on the same text no matter how blocks re-render between frames —
  // growing or shrinking, above or below the fold, or several at once in one
  // coalesced paint. Null while following the tail.
  private anchor: TranscriptLineOwner | null = null;
  // Owners of the last painted frame, so an explicit scroll can translate its
  // target row into a content anchor rather than a bottom-relative offset (which
  // a render coalesced with fresh stream deltas would misapply to a taller frame).
  private lastOwners: readonly (TranscriptLineOwner | null)[] = [];

  constructor(
    private readonly transcript: MakaTranscriptComponent,
    private readonly editor: Component,
    private readonly statusLine: Component,
    private readonly terminal: Terminal,
  ) {
    super();
    this.addChild(transcript);
    this.addChild(editor);
    this.addChild(statusLine);
  }

  render(width: number): string[] {
    const source = this.transcript.renderSource(width);
    const transcriptLines = source.lines;
    const editorLines = this.editor.render(width);
    const statusLines = this.statusLine.render(width);
    const viewportRows = Math.max(0, this.terminal.rows - editorLines.length - statusLines.length);

    if (width !== this.lastWidth) {
      // Rewrapping at a new width invalidates every line offset, so re-pin to the
      // tail rather than land the viewport on an arbitrary mid-message row.
      this.followTail = true;
      this.scrollOffset = 0;
      this.anchor = null;
    } else if (!this.followTail && this.anchor) {
      // A re-render (stream delta, expansion toggle, ...). Recompute the offset so
      // the anchored content line is back at the top of the viewport. Deriving it
      // from the anchor's live position — rather than nudging the old offset by a
      // line delta — is correct for every kind of change at once: only the anchor's
      // current row matters, not where or how the transcript grew or shrank.
      const anchorRow = findAnchorRow(source.owners, this.anchor);
      if (anchorRow < 0) {
        // The anchored entry is gone (e.g. a session switch replaced the
        // transcript); fall back to the tail rather than a stale position.
        this.followTail = true;
        this.scrollOffset = 0;
        this.anchor = null;
      } else {
        const contentRows = viewportRows >= 2 ? viewportRows - 1 : viewportRows;
        this.scrollOffset = Math.max(0, transcriptLines.length - anchorRow - contentRows);
      }
    }

    const windowed = windowTranscriptLines(
      transcriptLines,
      viewportRows,
      this.followTail ? 0 : this.scrollOffset,
      width,
    );
    this.scrollOffset = windowed.scrollOffset;
    this.followTail = windowed.scrollOffset === 0;
    this.anchor = this.followTail ? null : anchorOwnerAt(source.owners, windowed.hiddenAbove);
    this.lastOwners = source.owners;
    this.lastTotalLines = transcriptLines.length;
    this.lastViewportRows = viewportRows;
    this.lastWidth = width;

    const paddingRows = Math.max(0, viewportRows - windowed.lines.length);
    return [
      ...windowed.lines,
      ...Array.from({ length: paddingRows }, () => ''),
      ...editorLines,
      ...statusLines,
    ];
  }

  /** One indicator row is reserved when scrolling, so a page is that many content rows. */
  private pageSize(): number {
    return Math.max(1, this.lastViewportRows - 1);
  }

  private scrollBy(offsetDelta: number): boolean {
    if (this.lastTotalLines <= this.lastViewportRows) return false; // nothing hidden
    const maxOffset = Math.max(0, this.lastTotalLines - this.pageSize());
    const current = this.followTail ? 0 : this.scrollOffset;
    const next = Math.min(Math.max(0, current + offsetDelta), maxOffset);
    if (next === current) return false;
    if (next === 0) {
      this.followTail = true;
      this.scrollOffset = 0;
      this.anchor = null;
      return true;
    }
    // Translate the target offset into a content anchor from the last painted
    // frame. If the pending render coalesces with fresh stream deltas, deriving
    // the offset from that anchor against the taller transcript lands the user on
    // the page they asked for, instead of applying a stale bottom-relative offset.
    const contentRows = this.lastViewportRows >= 2 ? this.lastViewportRows - 1 : this.lastViewportRows;
    const targetStart = Math.max(0, this.lastTotalLines - next - contentRows);
    this.followTail = false;
    this.scrollOffset = next; // provisional; render recomputes from the anchor when set
    this.anchor = anchorOwnerAt(this.lastOwners, targetStart);
    return true;
  }

  /** Scroll toward older output by one page. Returns false when already at the top. */
  scrollUp(): boolean {
    return this.scrollBy(this.pageSize());
  }

  /** Scroll toward newer output by one page. Returns false when already following the tail. */
  scrollDown(): boolean {
    return this.scrollBy(-this.pageSize());
  }

  /**
   * True when the transcript overflows the viewport, i.e. paging keys should
   * scroll it. When false the transcript fits and PageUp/PageDown page the
   * editor's own multi-line input buffer instead. A zero-row viewport (the
   * editor and status filled a very short terminal) renders no transcript at
   * all, so paging must fall through to the editor even with content buffered.
   */
  isScrollable(): boolean {
    return this.lastViewportRows > 0 && this.lastTotalLines > this.lastViewportRows;
  }

  /**
   * Re-pin to the live tail. Call when the transcript is replaced wholesale (a
   * session switch) or the user submits, so the viewport follows the newest
   * output instead of holding a now-irrelevant scroll position.
   */
  followTailNow(): void {
    this.followTail = true;
    this.scrollOffset = 0;
    this.anchor = null;
  }
}
