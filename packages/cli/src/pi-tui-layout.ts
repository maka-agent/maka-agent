import { Container, type Component, type Terminal } from '@earendil-works/pi-tui';
import {
  renderMakaPiActivityStrip,
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
    private readonly editor: Component,
    private readonly statusLine: Component,
    private readonly terminal: Terminal,
  ) {
    super();
    this.addChild(transcript);
    this.addChild(activityStrip);
    this.addChild(editor);
    this.addChild(statusLine);
  }

  render(width: number): string[] {
    const transcriptLines = this.transcript.render(width);
    const activityLines = this.activityStrip.render(width);
    const editorLines = this.editor.render(width);
    const statusLines = this.statusLine.render(width);
    const chromeRows = activityLines.length + editorLines.length + statusLines.length;
    const viewportRows = Math.max(0, this.terminal.rows - chromeRows);
    const paddingRows = Math.max(0, viewportRows - transcriptLines.length);
    return [
      ...transcriptLines,
      ...Array.from({ length: paddingRows }, () => ''),
      ...activityLines,
      ...editorLines,
      ...statusLines,
    ];
  }
}
