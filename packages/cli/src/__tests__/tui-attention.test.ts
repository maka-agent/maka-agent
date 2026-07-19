import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AttentionController, BUSY_SPINNER_FRAMES } from '../tui-attention.js';

const BUSY = `${BUSY_SPINNER_FRAMES[0]} Maka`;

const BELL = '\x07';

class SpyTerminal {
  readonly writes: string[] = [];
  readonly titles: string[] = [];
  write(data: string): void {
    this.writes.push(data);
  }
  setTitle(title: string): void {
    this.titles.push(title);
  }
  get bells(): number {
    return this.writes.filter((w) => w === BELL).length;
  }
  get title(): string | undefined {
    return this.titles.at(-1);
  }
}

/** A controller wired to a spy terminal, a clock, and a spinner ticked by hand. */
function makeController(longTurnThresholdMs = 8000) {
  const terminal = new SpyTerminal();
  let clock = 0;
  let spinnerTick: (() => void) | null = null;
  const controller = new AttentionController(terminal, {
    baseTitle: 'Maka',
    now: () => clock,
    longTurnThresholdMs,
    // Capture the spinner callback instead of scheduling a real interval, so the
    // test drives frame advances deterministically and no timer leaks.
    scheduleSpinnerInterval: (callback) => {
      spinnerTick = callback;
      return () => {
        spinnerTick = null;
      };
    },
  });
  return {
    terminal,
    controller,
    advance: (ms: number) => (clock += ms),
    tickSpinner: () => spinnerTick?.(),
    spinnerRunning: () => spinnerTick !== null,
  };
}

describe('AttentionController title', () => {
  test('starts on the plain base title', () => {
    const { terminal } = makeController();
    assert.equal(terminal.title, 'Maka');
  });

  test('updates the base title while preserving the current state marker', () => {
    const { terminal, controller } = makeController();
    controller.promptTurnStarted();

    controller.setBaseTitle('Generated title');

    assert.equal(terminal.title, `${BUSY_SPINNER_FRAMES[0]} Generated title`);
    controller.promptTurnEnded();
    assert.equal(terminal.title, 'Generated title');
  });

  test('marks busy while a turn runs and returns to plain when it ends quickly', () => {
    const { terminal, controller, advance } = makeController(8000);
    controller.promptTurnStarted();
    assert.equal(terminal.title, BUSY);
    advance(500);
    controller.promptTurnEnded();
    assert.equal(terminal.title, 'Maka');
    assert.equal(terminal.bells, 0);
  });

  test('control actions mark busy without ever ringing', () => {
    const { terminal, controller } = makeController();
    controller.focusChanged(false);
    controller.controlStarted();
    assert.equal(terminal.title, BUSY);
    controller.controlEnded();
    assert.equal(terminal.title, 'Maka');
    assert.equal(terminal.bells, 0);
  });

  test('writes the title only on a real change', () => {
    const { terminal, controller } = makeController();
    const before = terminal.titles.length;
    controller.focusChanged(true); // still focused, still idle → no new title
    assert.equal(terminal.titles.length, before);
  });

  test('reset clears the busy marker and goes inert', () => {
    const { terminal, controller } = makeController(8000);
    controller.focusChanged(false);
    controller.promptTurnStarted();
    assert.equal(terminal.title, BUSY);
    controller.reset();
    assert.equal(terminal.title, 'Maka');
    // A finalizer that settles after close must not re-dirty the handed-back
    // title or ring — every event method is now a no-op.
    controller.promptTurnEnded();
    controller.attentionNeeded();
    controller.promptTurnStarted();
    assert.equal(terminal.title, 'Maka');
    assert.equal(terminal.bells, 0);
  });

  test('animates the busy marker through spinner frames while a turn runs', () => {
    const { terminal, controller, tickSpinner, spinnerRunning } = makeController(8000);
    controller.promptTurnStarted();
    assert.equal(terminal.title, `${BUSY_SPINNER_FRAMES[0]} Maka`);
    assert.equal(spinnerRunning(), true);

    tickSpinner();
    assert.equal(terminal.title, `${BUSY_SPINNER_FRAMES[1]} Maka`);
    tickSpinner();
    assert.equal(terminal.title, `${BUSY_SPINNER_FRAMES[2]} Maka`);

    controller.promptTurnEnded();
    assert.equal(terminal.title, 'Maka');
    // The interval is released and the frame resets, so the next turn opens on
    // the first frame rather than mid-cycle.
    assert.equal(spinnerRunning(), false);
    controller.promptTurnStarted();
    assert.equal(terminal.title, `${BUSY_SPINNER_FRAMES[0]} Maka`);
  });

  test('stops the spinner while an attention marker overrides the busy marker', () => {
    const { controller, spinnerRunning } = makeController(8000);
    controller.focusChanged(false);
    controller.promptTurnStarted();
    assert.equal(spinnerRunning(), true);
    // A permission prompt while unfocused mid-turn raises attention (★), which
    // outranks the busy marker; the spinner must stop rather than animate a
    // marker that is no longer shown.
    controller.attentionNeeded();
    assert.equal(spinnerRunning(), false);
  });
});

describe('AttentionController long-turn ring', () => {
  test('rings and marks attention when a long turn ends while unfocused', () => {
    const { terminal, controller, advance } = makeController(8000);
    controller.focusChanged(false);
    controller.promptTurnStarted();
    advance(9000);
    controller.promptTurnEnded();
    assert.equal(terminal.bells, 1);
    assert.equal(terminal.title, '★ Maka');
  });

  test('stays silent when a long turn ends while focused', () => {
    const { terminal, controller, advance } = makeController(8000);
    controller.promptTurnStarted();
    advance(9000);
    controller.promptTurnEnded();
    assert.equal(terminal.bells, 0);
    assert.equal(terminal.title, 'Maka');
  });

  test('does not ring for a short turn even while unfocused', () => {
    const { terminal, controller, advance } = makeController(8000);
    controller.focusChanged(false);
    controller.promptTurnStarted();
    advance(200);
    controller.promptTurnEnded();
    assert.equal(terminal.bells, 0);
    assert.equal(terminal.title, 'Maka');
  });

  test('regaining focus clears the attention marker', () => {
    const { terminal, controller, advance } = makeController(8000);
    controller.focusChanged(false);
    controller.promptTurnStarted();
    advance(9000);
    controller.promptTurnEnded();
    assert.equal(terminal.title, '★ Maka');
    controller.focusChanged(true);
    assert.equal(terminal.title, 'Maka');
  });

  test('a new turn clears a stale attention marker', () => {
    const { terminal, controller, advance } = makeController(8000);
    controller.focusChanged(false);
    controller.promptTurnStarted();
    advance(9000);
    controller.promptTurnEnded();
    assert.equal(terminal.title, '★ Maka');
    controller.promptTurnStarted();
    assert.equal(terminal.title, BUSY);
  });
});

describe('AttentionController attention events', () => {
  test('rings for a permission prompt or error while unfocused', () => {
    const { terminal, controller } = makeController();
    controller.focusChanged(false);
    controller.attentionNeeded();
    assert.equal(terminal.bells, 1);
    assert.equal(terminal.title, '★ Maka');
  });

  test('stays silent for a permission prompt or error while focused', () => {
    const { terminal, controller } = makeController();
    controller.attentionNeeded();
    assert.equal(terminal.bells, 0);
    assert.equal(terminal.title, 'Maka');
  });

  test('never rings on a terminal that never reports a blur (no 1004 support)', () => {
    // Without focus reports the controller assumes focus and suppresses every
    // ring — the conservative degradation. Title busy/idle still tracks.
    const { terminal, controller, advance } = makeController(8000);
    controller.promptTurnStarted();
    advance(60_000);
    controller.promptTurnEnded();
    controller.attentionNeeded();
    assert.equal(terminal.bells, 0);
  });
});
