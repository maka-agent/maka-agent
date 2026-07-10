import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createPinnedBottomFollower } from '../pinned-bottom.js';

describe('createPinnedBottomFollower', () => {
  it('follows every observed content growth while pinned', () => {
    const viewport = { scrollTop: 100, scrollHeight: 200 };
    const content = {} as Element;
    let notifyContentCommit!: () => void;
    let observed: Element | undefined;
    let disconnected = false;
    const stop = createPinnedBottomFollower({
      viewport,
      content,
      isPinned: () => true,
      createObserver: (callback) => {
        notifyContentCommit = callback;
        return {
          observe: (element) => { observed = element; },
          disconnect: () => { disconnected = true; },
        };
      },
    });

    assert.equal(observed, content);
    viewport.scrollHeight = 260;
    notifyContentCommit();
    assert.equal(viewport.scrollTop, 260);
    viewport.scrollHeight = 320;
    notifyContentCommit();
    assert.equal(viewport.scrollTop, 320);
    stop();
    assert.equal(disconnected, true);
  });

  it('does not move the viewport after the user unpins', () => {
    const viewport = { scrollTop: 100, scrollHeight: 200 };
    let pinned = true;
    let notifyContentCommit!: () => void;
    createPinnedBottomFollower({
      viewport,
      content: {} as Element,
      isPinned: () => pinned,
      createObserver: (callback) => {
        notifyContentCommit = callback;
        return { observe: () => {}, disconnect: () => {} };
      },
    });

    pinned = false;
    viewport.scrollHeight = 300;
    notifyContentCommit();
    assert.equal(viewport.scrollTop, 100);
  });
});
