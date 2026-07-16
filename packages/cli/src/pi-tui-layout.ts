import { Container, type Component, type Terminal } from '@earendil-works/pi-tui';
import {
  renderMakaPiActivityStrip,
  renderMakaPiPendingQueue,
  renderMakaPiStatusLine,
  renderMakaPiTranscript,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from './pi-transcript.js';

export class MakaTranscriptComponent implements Component {
  constructor(
    private readonly state: MakaPiTranscriptState,
    private readonly metadata: () => MakaPiTranscriptMetadata,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderMakaPiTranscript(this.state, this.metadata(), width);
  }
}

export class MakaStatusLineComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiStatusLine(this.metadata(), width)];
  }
}

export class MakaActivityStripComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiActivityStrip(this.metadata(), width)];
  }
}

/** The pending-queue bar (Steering:/Queued:) rendered just above the editor. */
export class MakaPendingQueueComponent implements Component {
  constructor(private readonly state: MakaPiTranscriptState) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderMakaPiPendingQueue(this.state, width);
  }
}

/**
 * Stacks the transcript above the editor and status line. The transcript is
 * never windowed: every line is emitted and, when the whole document is taller
 * than the terminal, pi-tui's differential renderer scrolls older output into
 * the terminal's own scrollback (exactly as the upstream Pi TUI does). History
 * is scrolled with the terminal/trackpad rather than an in-app pager, so long
 * output is never truncated.
 *
 * The only layout work is bottom-anchoring: while the transcript fits, blank
 * rows pad it up so the editor and status line sit at the bottom of the screen.
 * Once it overflows the padding is gone and the buffer grows past the viewport.
 */
export class MakaPiLayoutComponent extends Container {
  constructor(
    private readonly transcript: MakaTranscriptComponent,
    private readonly activityStrip: MakaActivityStripComponent,
    private readonly pendingQueue: MakaPendingQueueComponent,
    private readonly editor: Component,
    private readonly statusLine: Component,
    private readonly terminal: Terminal,
  ) {
    super();
    this.addChild(transcript);
    this.addChild(activityStrip);
    this.addChild(pendingQueue);
    this.addChild(editor);
    this.addChild(statusLine);
  }

  render(width: number): string[] {
    const transcriptLines = this.transcript.render(width);
    const activityLines = this.activityStrip.render(width);
    const pendingLines = this.pendingQueue.render(width);
    const editorLines = this.editor.render(width);
    const statusLines = this.statusLine.render(width);
    // #1064: when the activity strip is showing (a turn is running), separate
    // it from the last transcript line with a blank row. Without this, a
    // thinking or tool row (the agent-work stack, which has no internal blank
    // gaps) sits directly against `Working… 12s`.
    const activityActive = activityLines.length > 0 && activityLines.some((line) => line.length > 0);
    const lastTranscriptLine = transcriptLines[transcriptLines.length - 1];
    const needGap = activityActive && lastTranscriptLine !== undefined && lastTranscriptLine.length > 0;
    const paddedTranscript = needGap ? [...transcriptLines, ''] : transcriptLines;
    const chromeRows = activityLines.length + pendingLines.length + editorLines.length + statusLines.length;
    const viewportRows = Math.max(0, this.terminal.rows - chromeRows);
    const paddingRows = Math.max(0, viewportRows - paddedTranscript.length);
    return [
      ...paddedTranscript,
      ...Array.from({ length: paddingRows }, () => ''),
      ...activityLines,
      ...pendingLines,
      ...editorLines,
      ...statusLines,
    ];
  }
}
