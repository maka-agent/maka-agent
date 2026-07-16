import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { Component, Terminal } from '@earendil-works/pi-tui';
import { _setColorLevelForTesting } from '../tui-ansi.js';
import {
  applyMakaSessionEventToTranscript,
  createMakaPiTranscriptState,
  replaceTranscriptWithStoredMessages,
  toggleAllToolExpansion,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from '../pi-transcript.js';
import {
  MakaActivityStripComponent,
  MakaPendingQueueComponent,
  MakaPiLayoutComponent,
  MakaStatusLineComponent,
  MakaTranscriptComponent,
} from '../pi-tui-layout.js';
import type { SessionEvent } from '@maka/core';

before(() => _setColorLevelForTesting(3));

// The viewport-top estimate must shadow pi-tui's real viewport (#1097): reset
// to the document tail exactly when pi-tui would full-redraw (size change,
// change above the top, shrink below the top), stay monotonic otherwise.
describe('MakaPiLayoutComponent viewport geometry', () => {
  test('a wholesale replacement (/new) re-anchors the viewport and keeps toggles alive', () => {
    const { state, layout } = harness();
    growTranscript(state, 60);
    layout.render(80);
    assert.ok(state.renderGeometry.viewportTop > 0);

    replaceTranscriptWithStoredMessages(state, []);
    layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, 0);

    addTool(state, 'tool-new', 'echo hi');
    layout.render(80);
    assert.equal(toggleAllToolExpansion(state), true);
  });

  test('a terminal size change re-anchors the viewport to the document tail', () => {
    const { state, layout, terminal } = harness();
    growTranscript(state, 60);
    const lines = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, lines.length - 24);

    terminal.rows = 50;
    const taller = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, taller.length - 50));

    // pi-tui full-redraws on any width change, even without a wrap difference.
    terminal.rows = 24;
    layout.render(80);
    const before = state.renderGeometry.viewportTop;
    terminal.columns = 120;
    const wider = layout.render(120);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, wider.length - 24));
    assert.ok(state.renderGeometry.viewportTop <= before);
  });

  test('a shallow truncation keeps the viewport top, a deep one re-anchors it', () => {
    const { state, layout } = harness();
    growTranscript(state, 60, 'message-1');
    growTranscript(state, 60, 'message-2');
    addTool(state, 'tool-tail', 'echo tail');
    layout.render(80);
    const top = state.renderGeometry.viewportTop;
    assert.ok(top > 0);

    // Shallow: dropping the tail entry keeps the document longer than the
    // viewport top; pi-tui clears the vacated rows without a full redraw and
    // its viewport stays put, so the estimate must too.
    state.entries.pop();
    layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, top);

    // Deep: truncating below the viewport top forces pi-tui's full redraw,
    // which re-anchors its viewport to the new document tail.
    state.entries.length = 1;
    const shrunk = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, Math.max(0, shrunk.length - 24));
    assert.ok(state.renderGeometry.viewportTop < top);
  });

  test('appends and in-viewport edits keep the viewport top monotonic', () => {
    const { state, layout } = harness();
    growTranscript(state, 60);
    layout.render(80);
    const top = state.renderGeometry.viewportTop;

    addTool(state, 'tool-append', 'echo more');
    const grown = layout.render(80);
    assert.equal(state.renderGeometry.viewportTop, grown.length - 24);
    assert.ok(state.renderGeometry.viewportTop >= top);
  });
});

interface StubTerminal {
  rows: number;
  columns: number;
}

function harness(): { state: MakaPiTranscriptState; layout: MakaPiLayoutComponent; terminal: StubTerminal } {
  const state = createMakaPiTranscriptState();
  const metadata = (): MakaPiTranscriptMetadata => ({
    title: 'Maka',
    cwd: '/repo',
    model: 'deepseek-v4-flash',
    connectionSlug: 'deepseek',
    permissionMode: 'ask',
    usage: state.usage,
  });
  const terminal: StubTerminal = { rows: 24, columns: 80 };
  const stubComponent = (lines: string[]): Component => ({ render: () => lines, invalidate: () => {} });
  const layout = new MakaPiLayoutComponent(
    state,
    new MakaTranscriptComponent(state, metadata),
    new MakaActivityStripComponent(metadata),
    new MakaPendingQueueComponent(state),
    stubComponent(['editor-1', 'editor-2', 'editor-3']),
    new MakaStatusLineComponent(metadata),
    terminal as unknown as Terminal,
  );
  return { state, layout, terminal };
}

function growTranscript(state: MakaPiTranscriptState, paragraphs: number, messageId = 'message-filler'): void {
  applyMakaSessionEventToTranscript(state, event({
    type: 'text_delta',
    messageId,
    text: Array.from({ length: paragraphs }, (_, i) => `${messageId}-filler-${i}`).join('\n\n'),
  }));
}

function addTool(state: MakaPiTranscriptState, toolUseId: string, command: string): void {
  applyMakaSessionEventToTranscript(state, event({
    type: 'tool_start', toolUseId, toolName: 'Bash', args: { command },
  }));
  applyMakaSessionEventToTranscript(state, event({
    type: 'tool_result', toolUseId, isError: false,
    content: { kind: 'text', text: 'ok' },
  }));
}

function event(input: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent {
  return {
    id: `${input.type}-id`,
    turnId: 'turn-1',
    ts: 1,
    ...input,
  } as SessionEvent;
}
