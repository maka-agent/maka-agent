import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PTY_SCROLLBACK_ROWS, PtyScreenCollector } from '../pty-screen-collector.js';
import { loadPtyStack } from '../pty-stack.js';

describe('PtyScreenCollector', () => {
  test('restores cursor visibility after a DECSTR soft reset', async () => {
    const { collector, failures } = await createCollector();
    try {
      collector.accept('\u001b[?25lhidden');
      assert.equal((await collector.snapshotAtCut()).output.cursor.visible, false);

      collector.accept('\u001b[!p');
      assert.equal((await collector.snapshotAtCut()).output.cursor.visible, true);
      assert.deepEqual(failures, []);
    } finally {
      collector.dispose();
    }
  });

  test('distinguishes an intentional screen clear from scrollback eviction', async () => {
    const { collector, failures } = await createCollector();
    try {
      collector.accept('BEFORE\u001b[2J\u001b[HAFTER');
      const cleared = (await collector.snapshotAtCut()).output;
      assert.equal(cleared.screen, 'AFTER');
      assert.equal(cleared.truncated, false);

      collector.accept(
        Array.from({ length: PTY_SCROLLBACK_ROWS + 23 }, (_, index) => `line-${index}\r\n`).join(
          '',
        ),
      );
      assert.equal((await collector.snapshotAtCut()).output.truncated, false);

      collector.accept('\u001b[?1049hALT\u001b[?1049l');
      assert.equal((await collector.snapshotAtCut()).output.truncated, false);

      collector.accept('evicts-oldest\r\n');
      assert.equal((await collector.snapshotAtCut()).output.truncated, true);
      assert.deepEqual(failures, []);
    } finally {
      collector.dispose();
    }
  });
});

async function createCollector(): Promise<{
  collector: PtyScreenCollector;
  failures: Error[];
}> {
  const failures: Error[] = [];
  const collector = new PtyScreenCollector({
    stack: await loadPtyStack(),
    onProtocolReply: () => {},
    onDirty: () => {},
    onFailure: (error) => failures.push(error),
    pauseSource: () => {},
    resumeSource: () => {},
  });
  return { collector, failures };
}
