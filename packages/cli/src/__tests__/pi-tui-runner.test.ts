import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { MakaSessionDriver } from '../session-driver.js';
import { runMakaPiTui } from '../pi-tui-runner.js';

describe('Maka Pi TUI runner', () => {
  test('restores the terminal when driver stop rejects during close', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('\x03');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-C');
      }),
    ]);

    assert.equal(driver.stopCalls, 1);
    assert.equal(terminal.stopCalls, 1);
    assert.equal(terminal.progressStates.at(-1), false);
  });
});

class RejectingStopDriver implements MakaSessionDriver {
  stopCalls = 0;

  async *sendPrompt(_prompt: string): AsyncIterable<never> {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error('stop failed');
  }

  getSessionId(): string {
    return 'session-1';
  }
}

class FakeTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;
  readonly progressStates: boolean[] = [];
  stopCalls = 0;
  private onInput: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  drainInput(): Promise<void> {
    return Promise.resolve();
  }

  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}

  setProgress(active: boolean): void {
    this.progressStates.push(active);
  }

  input(data: string): void {
    this.onInput?.(data);
  }
}
