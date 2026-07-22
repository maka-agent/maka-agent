import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolActivityItem, TurnTimelineItem } from '../materialize.js';
import { foldTimeline, type FoldedTimelineEntry } from '../timeline-fold.js';

function thinking(messageId: string, live?: boolean): TurnTimelineItem {
  return { kind: 'thinking', text: `reasoning ${messageId}`, messageId, ...(live !== undefined ? { live } : {}) };
}

function text(messageId: string, body = `answer ${messageId}`): TurnTimelineItem {
  return { kind: 'text', text: body, messageId };
}

function tool(id: string, toolName = 'Read'): ToolActivityItem {
  return { toolUseId: id, toolName, status: 'completed', args: {} };
}

function tools(...items: ToolActivityItem[]): TurnTimelineItem {
  return { kind: 'tools', items };
}

function kinds(entries: readonly FoldedTimelineEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

function childKinds(entry: FoldedTimelineEntry | undefined): string[] {
  return entry?.kind === 'processing' ? entry.children.map((child) => child.kind) : [];
}

describe('foldTimeline (#1307)', () => {
  test('leaves a pure-thinking run bare instead of folding it', () => {
    const folded = foldTimeline([thinking('a1')]);
    // No tools in the run → no processing block; the 深度思考 disclosure
    // renders the reasoning directly.
    assert.deepEqual(kinds(folded), ['thinking']);
  });

  test('folds a pure-tools run into one processing block', () => {
    const folded = foldTimeline([tools(tool('c1'))]);
    assert.deepEqual(kinds(folded), ['processing']);
    assert.deepEqual(childKinds(folded[0]), ['tools']);
  });

  test('keeps interleaved thinking + tools inside one block, in order', () => {
    const folded = foldTimeline([thinking('a1'), tools(tool('c1'))]);
    assert.deepEqual(kinds(folded), ['processing']);
    assert.deepEqual(childKinds(folded[0]), ['thinking', 'tools']);
  });

  test('answer text is a boundary: runs around each text fold independently', () => {
    const folded = foldTimeline([
      thinking('a1'),
      text('a1', 'step one'),
      tools(tool('c1')),
      thinking('a2'),
      text('a2', 'step two'),
      tools(tool('c2')),
    ]);
    // thinking (pure run stays bare), text, processing[tools, thinking],
    // text, processing[tools]
    assert.deepEqual(kinds(folded), ['thinking', 'text', 'processing', 'text', 'processing']);
    assert.deepEqual(childKinds(folded[2]), ['tools', 'thinking']);
    assert.deepEqual(childKinds(folded[4]), ['tools']);
    assert.equal((folded[1] as { text: string }).text, 'step one');
    assert.equal((folded[3] as { text: string }).text, 'step two');
  });

  test('block ids derive from the preceding text and are stable across tool projection', () => {
    const before = foldTimeline([
      text('a1'),
      thinking('a2'),
      tools(tool('c1'), tool('c2')),
    ]);
    // Shell-run folding can project the FIRST tool out of the group; the block
    // id must not change (a first-child-derived key would remount the
    // disclosure and drop a manual open/close).
    const after = foldTimeline([
      text('a1'),
      thinking('a2'),
      tools(tool('c2')),
    ]);
    assert.equal(before[1]?.kind, 'processing');
    assert.equal(after[1]?.kind, 'processing');
    assert.equal(
      before[1]?.kind === 'processing' ? before[1].id : undefined,
      after[1]?.kind === 'processing' ? after[1].id : undefined,
    );
    assert.equal(before[1]?.kind === 'processing' ? before[1].id : undefined, 'a1');
  });

  test('a block that opens the turn uses the stable "start" id', () => {
    const folded = foldTimeline([tools(tool('c1')), text('a1')]);
    assert.equal(folded[0]?.kind === 'processing' ? folded[0].id : undefined, 'start');
  });
});
