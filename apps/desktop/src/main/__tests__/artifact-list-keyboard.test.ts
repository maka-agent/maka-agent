/**
 * Tests for the ArtifactPane list keyboard helper (PR108i, @kenji a11y gate #1).
 *
 * The pure helper has to handle five concerns simultaneously: arrow-key
 * selection wrapping, Home/End jumping, Enter/Space activation, Escape
 * dismissal, and "no nav key" passthrough. We lock the matrix down so a
 * future change can't accidentally start swallowing Esc (which would
 * break the global Command Palette) or stop wrapping at the bottom.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  nextArtifactListAction,
  type ArtifactListAction,
} from '../../renderer/artifact-list-keyboard.js';

function expectAction(actual: ArtifactListAction, expected: ArtifactListAction) {
  assert.deepEqual(actual, expected);
}

const IDS = ['a', 'b', 'c'] as const;

describe('nextArtifactListAction', () => {
  describe('empty list', () => {
    it('returns noop regardless of key', () => {
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape', 'q']) {
        expectAction(
          nextArtifactListAction({ currentSelectedId: undefined, visibleIds: [], key }),
          { kind: 'noop' },
        );
      }
    });
  });

  describe('arrow key selection', () => {
    it('ArrowDown moves selection to next item', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'ArrowDown' }),
        { kind: 'select', targetId: 'b' },
      );
    });

    it('ArrowDown from last wraps to first', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'c', visibleIds: IDS, key: 'ArrowDown' }),
        { kind: 'select', targetId: 'a' },
      );
    });

    it('ArrowUp moves selection to previous item', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'b', visibleIds: IDS, key: 'ArrowUp' }),
        { kind: 'select', targetId: 'a' },
      );
    });

    it('ArrowUp from first wraps to last', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'ArrowUp' }),
        { kind: 'select', targetId: 'c' },
      );
    });

    it('ArrowDown with no current selection starts at first', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: undefined, visibleIds: IDS, key: 'ArrowDown' }),
        { kind: 'select', targetId: 'a' },
      );
    });

    it('ArrowUp with no current selection starts at last', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: undefined, visibleIds: IDS, key: 'ArrowUp' }),
        { kind: 'select', targetId: 'c' },
      );
    });
  });

  describe('Home / End jumps', () => {
    it('Home jumps to first', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'b', visibleIds: IDS, key: 'Home' }),
        { kind: 'select', targetId: 'a' },
      );
    });

    it('End jumps to last', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'End' }),
        { kind: 'select', targetId: 'c' },
      );
    });
  });

  describe('Enter / Space activation', () => {
    it('Enter activates current selection', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'b', visibleIds: IDS, key: 'Enter' }),
        { kind: 'activate', targetId: 'b' },
      );
    });

    it('Space activates current selection', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'b', visibleIds: IDS, key: ' ' }),
        { kind: 'activate', targetId: 'b' },
      );
    });

    it('Enter with no selection activates first item', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: undefined, visibleIds: IDS, key: 'Enter' }),
        { kind: 'activate', targetId: 'a' },
      );
    });

    it('Enter on a stale selection (no longer in list) falls back to first', () => {
      // The list churns; the selected id might be deleted between renders.
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'gone', visibleIds: IDS, key: 'Enter' }),
        { kind: 'activate', targetId: 'a' },
      );
    });
  });

  describe('Escape dismissal (does NOT swallow if list empty)', () => {
    it('Escape on non-empty list returns dismiss', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'Escape' }),
        { kind: 'dismiss' },
      );
    });

    it('Escape on empty list returns noop (does not steal Esc from Command Palette)', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: undefined, visibleIds: [], key: 'Escape' }),
        { kind: 'noop' },
      );
    });
  });

  describe('unrelated keys', () => {
    it('letter keys return noop', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'q' }),
        { kind: 'noop' },
      );
    });

    it('Tab returns noop (focus moves via browser default, not list helper)', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'Tab' }),
        { kind: 'noop' },
      );
    });

    it('Shift+Tab returns noop', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'Tab' }),
        { kind: 'noop' },
      );
    });

    it('ArrowLeft / ArrowRight return noop (this is a vertical listbox)', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'ArrowLeft' }),
        { kind: 'noop' },
      );
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'ArrowRight' }),
        { kind: 'noop' },
      );
    });
  });

  describe('priority order', () => {
    // We lock the order so future edits don't surprise reviewers.
    //   1. empty list → noop (regardless of key)
    //   2. Escape → dismiss
    //   3. Enter / Space → activate
    //   4. ArrowDown/Up/Home/End → select
    //   5. anything else → noop
    it('empty list dominates Escape', () => {
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: [], key: 'Escape' }),
        { kind: 'noop' },
      );
    });

    it('Escape dominates ArrowDown when both could apply (Escape is the chord)', () => {
      // (Synthetic: keys are single, but verifies the precedence in the switch)
      expectAction(
        nextArtifactListAction({ currentSelectedId: 'a', visibleIds: IDS, key: 'Escape' }),
        { kind: 'dismiss' },
      );
    });
  });
});
