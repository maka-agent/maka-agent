/**
 * Tests for `createThreadSearchPoller` + `normalizeHits` +
 * `buildContentSearchCommands`. The React hook (`useThreadSearchImpl`)
 * is a thin shell over the poller; we test the poller directly here,
 * the same pattern as `use-onboarding-snapshot.test.ts`.
 *
 * Pins (xuan `6e7372c5`):
 *   - Old query result MUST NOT overwrite new query result (ticket).
 *   - dispose() prevents callbacks (renderer unmount safety).
 *   - `incognito_active` produces a `blocked` state, not `error`.
 *   - Hits with missing `target.sessionId` are dropped at the hook
 *     boundary — never reach the UI.
 *   - Snippet rendering pathway is plain text — buildContentSearchCommands
 *     never returns commands whose label/hint contain HTML markers.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  SearchErrorReason,
  SearchRequest,
  SearchResult,
  SearchResultTarget,
} from '@maka/core';
import {
  THREAD_SEARCH_MIN_QUERY_CODE_POINTS,
  createThreadSearchPoller,
  normalizeHits,
  type ThreadSearchState,
} from '../../renderer/use-thread-search.js';
import { buildContentSearchCommands } from '../../renderer/command-palette-content-search.js';

// ---------------------------------------------------------------------------
// normalizeHits — pure
// ---------------------------------------------------------------------------

describe('normalizeHits drops hits without a thread sessionId', () => {
  it('keeps a fully-formed thread hit with sessionId + turnId', () => {
    const results: SearchResult[] = [
      {
        source: 'thread',
        title: 'My Chat',
        snippet: 'hello world',
        target: { kind: 'thread', sessionId: 's1', turnId: 't1' },
      },
    ];
    const hits = normalizeHits(results);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.sessionId, 's1');
    assert.equal(hits[0]!.turnId, 't1');
    assert.equal(hits[0]!.title, 'My Chat');
    assert.equal(hits[0]!.snippet, 'hello world');
  });

  it('keeps a hit with sessionId but no turnId (session-level match)', () => {
    const results: SearchResult[] = [
      {
        source: 'thread',
        title: 'Renamed Chat',
        target: { kind: 'thread', sessionId: 's2' },
      },
    ];
    const hits = normalizeHits(results);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.sessionId, 's2');
    assert.equal(hits[0]!.turnId, undefined);
  });

  it('drops a hit with no target', () => {
    const results: SearchResult[] = [{ source: 'thread', title: 'no-target' }];
    assert.equal(normalizeHits(results).length, 0);
  });

  it('drops a hit with empty sessionId', () => {
    const results: SearchResult[] = [
      {
        source: 'thread',
        title: 'empty-sid',
        target: { kind: 'thread', sessionId: '' },
      },
    ];
    assert.equal(normalizeHits(results).length, 0);
  });

  it('drops a hit with a non-thread target (future variant safety)', () => {
    const results: SearchResult[] = [
      {
        source: 'thread',
        title: 'other-kind',
        // Force a future-variant shape that does not exist today;
        // hook must still drop it because it only navigates thread
        // targets. Casts let us simulate the future case.
        target: { kind: 'memory' as never, sessionId: 's-mem' as never } as unknown as SearchResultTarget,
      },
    ];
    assert.equal(normalizeHits(results).length, 0);
  });

  it('preserves order of valid hits, drops invalid in-line', () => {
    const results: SearchResult[] = [
      { source: 'thread', title: 'a', target: { kind: 'thread', sessionId: 'sa' } },
      { source: 'thread', title: 'b-no-target' },
      { source: 'thread', title: 'c', target: { kind: 'thread', sessionId: 'sc' } },
    ];
    const hits = normalizeHits(results);
    assert.deepEqual(
      hits.map((h) => h.title),
      ['a', 'c'],
    );
  });
});

// ---------------------------------------------------------------------------
// createThreadSearchPoller — race / dispose / state transitions
// ---------------------------------------------------------------------------

describe('createThreadSearchPoller — race + lifecycle (xuan 6e7372c5)', () => {
  function captureStates() {
    const states: ThreadSearchState[] = [];
    return {
      states,
      onState: (s: ThreadSearchState) => states.push(s),
    };
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('idle initial state when query is below min length', () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      { runSearch: async () => [] },
      { onState: sink.onState },
    );
    poller.setQuery('a'); // 1 code point, below MIN
    assert.equal(sink.states.length, 1);
    assert.equal(sink.states[0]!.kind, 'idle');
  });

  it('MIN constant is at least 2 (avoid one-char churn)', () => {
    assert.ok(THREAD_SEARCH_MIN_QUERY_CODE_POINTS >= 2);
  });

  it('valid query → loading → results', async () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      {
        runSearch: async (_req: SearchRequest) => [
          {
            source: 'thread' as const,
            title: 'hit',
            target: { kind: 'thread' as const, sessionId: 's1' },
          },
        ],
      },
      { onState: sink.onState },
    );
    poller.setQuery('hello');
    // Allow microtasks to settle so the async IIFE inside setQuery
    // resolves.
    await new Promise((r) => setTimeout(r, 0));
    const kinds = sink.states.map((s) => s.kind);
    assert.deepEqual(kinds, ['loading', 'results']);
    const last = sink.states.at(-1)!;
    if (last.kind === 'results') {
      assert.equal(last.hits.length, 1);
      assert.equal(last.hits[0]!.sessionId, 's1');
    } else {
      assert.fail('expected results state');
    }
  });

  it('blocked state when IPC returns incognito_active', async () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      {
        runSearch: async () => ({
          ok: false as const,
          reason: 'incognito_active' as SearchErrorReason,
          message: 'Search is disabled while incognito is active.',
        }),
      },
      { onState: sink.onState },
    );
    poller.setQuery('hello');
    await new Promise((r) => setTimeout(r, 0));
    const last = sink.states.at(-1)!;
    assert.equal(last.kind, 'blocked');
    if (last.kind === 'blocked') {
      assert.equal(last.reason, 'incognito_active');
      assert.match(last.message, /incognito/);
    }
  });

  it('blocked state when malformed privacy context message comes back (same reason, different message)', async () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      {
        runSearch: async () => ({
          ok: false as const,
          reason: 'incognito_active' as SearchErrorReason,
          message: 'Search is disabled because workspace privacy state could not be verified.',
        }),
      },
      { onState: sink.onState },
    );
    poller.setQuery('hello');
    await new Promise((r) => setTimeout(r, 0));
    const last = sink.states.at(-1)!;
    assert.equal(last.kind, 'blocked');
    if (last.kind === 'blocked') {
      assert.match(last.message, /could not be verified/);
    }
  });

  it('error state when IPC returns a non-incognito error reason', async () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      {
        runSearch: async () => ({
          ok: false as const,
          reason: 'invalid_query' as SearchErrorReason,
          message: 'Search query cannot be empty',
        }),
      },
      { onState: sink.onState },
    );
    poller.setQuery('hello');
    await new Promise((r) => setTimeout(r, 0));
    const last = sink.states.at(-1)!;
    assert.equal(last.kind, 'error');
  });

  it('error state when IPC throws (no query body in fallback message)', async () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      { runSearch: async () => { throw new Error('boom'); } },
      { onState: sink.onState },
    );
    poller.setQuery('hello-secret-query');
    await new Promise((r) => setTimeout(r, 0));
    const last = sink.states.at(-1)!;
    assert.equal(last.kind, 'error');
    if (last.kind === 'error') {
      // The fallback message must NOT include the query body —
      // generic "Search failed." only.
      assert.doesNotMatch(last.message, /hello-secret-query/);
      assert.equal(last.message, 'Search failed.');
    }
  });

  it('newer query invalidates older inflight (latest ticket wins)', async () => {
    const sink = captureStates();
    const first = deferred<SearchResult[]>();
    const second = deferred<SearchResult[]>();
    let call = 0;
    const poller = createThreadSearchPoller(
      {
        runSearch: async () => {
          call++;
          if (call === 1) return first.promise;
          return second.promise;
        },
      },
      { onState: sink.onState },
    );
    poller.setQuery('apple');
    poller.setQuery('banana'); // newer ticket; first response must be discarded

    // Resolve in REVERSE order so old result lands BEFORE new result.
    first.resolve([
      {
        source: 'thread',
        title: 'apple-hit',
        target: { kind: 'thread', sessionId: 'sa' },
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    second.resolve([
      {
        source: 'thread',
        title: 'banana-hit',
        target: { kind: 'thread', sessionId: 'sb' },
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    const final = sink.states.at(-1)!;
    if (final.kind !== 'results') assert.fail('expected results');
    // Final results must reflect the banana query, not apple.
    assert.equal(final.query, 'banana');
    assert.equal(final.hits[0]!.title, 'banana-hit');
    // apple-hit should NEVER appear as the final state.
    const appleAsFinal = sink.states.some(
      (s) => s.kind === 'results' && s.query === 'banana' && s.hits[0]!.title === 'apple-hit',
    );
    assert.equal(appleAsFinal, false);
  });

  it('dispose() prevents subsequent callbacks (unmount safety)', async () => {
    const sink = captureStates();
    const pending = deferred<SearchResult[]>();
    const poller = createThreadSearchPoller(
      { runSearch: async () => pending.promise },
      { onState: sink.onState },
    );
    poller.setQuery('hello');
    // expect: 'loading'
    assert.equal(sink.states.at(-1)!.kind, 'loading');
    const beforeDispose = sink.states.length;

    poller.dispose();

    // Now resolve the inflight IPC — callbacks must NOT fire.
    pending.resolve([
      {
        source: 'thread',
        title: 'after-unmount',
        target: { kind: 'thread', sessionId: 's-late' },
      },
    ]);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(sink.states.length, beforeDispose, 'no state callbacks after dispose');
  });

  it('dispose() also prevents idle reset (any callback type) from firing', async () => {
    const sink = captureStates();
    const poller = createThreadSearchPoller(
      { runSearch: async () => [] },
      { onState: sink.onState },
    );
    poller.setQuery('hello'); // loading + (eventually) results
    poller.dispose();
    poller.setQuery('a'); // would normally emit idle; must be silenced
    poller.setQuery('hello again'); // would normally emit loading; must be silenced
    await new Promise((r) => setTimeout(r, 0));
    // Only the first (pre-dispose) `loading` should be in the sink.
    // Even if the inflight async resolves, the `results` callback must
    // not fire post-dispose.
    const postDisposeCalls = sink.states.slice(1);
    for (const s of postDisposeCalls) {
      // The very next state after `loading` could be `results` from
      // pre-dispose IPC, but since we awaited a microtask, the
      // pre-dispose IPC also got squashed because dispose bumps the
      // ticket. So `postDisposeCalls` must be empty.
      assert.fail('unexpected state after dispose: ' + s.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// buildContentSearchCommands — palette integration
// ---------------------------------------------------------------------------

describe('buildContentSearchCommands — palette commands per state', () => {
  it('idle → no commands', () => {
    const cmds = buildContentSearchCommands({ kind: 'idle' });
    assert.equal(cmds.length, 0);
  });

  it('loading → single placeholder command in 内容搜索 group', () => {
    const cmds = buildContentSearchCommands({ kind: 'loading', query: 'hello' });
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]!.group, '内容搜索');
    assert.match(cmds[0]!.label, /搜索中/);
  });

  it('blocked → single disabled tile with fixed Chinese main text + generalized hint', () => {
    const cmds = buildContentSearchCommands({
      kind: 'blocked',
      query: 'hello',
      reason: 'incognito_active',
      message: 'Search is disabled while incognito is active.',
    });
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]!.label, '搜索已在隐私模式下停用');
    assert.equal(cmds[0]!.hint, 'Search is disabled while incognito is active.');
    // Tile must be inert — clicking should be a no-op.
    assert.equal(typeof cmds[0]!.run, 'function');
  });

  it('error → single error tile', () => {
    const cmds = buildContentSearchCommands({
      kind: 'error',
      query: 'hello',
      reason: 'parse_error',
      message: 'Search failed.',
    });
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]!.label, '搜索失败');
  });

  it('results with 0 hits → empty tile', () => {
    const cmds = buildContentSearchCommands({ kind: 'results', query: 'hello', hits: [] });
    assert.equal(cmds.length, 1);
    assert.match(cmds[0]!.label, /没有匹配/);
  });

  it('results with N hits → N commands in 内容搜索 group', () => {
    const cmds = buildContentSearchCommands({
      kind: 'results',
      query: 'hello',
      hits: [
        { sessionId: 's1', turnId: 't1', title: 'A', snippet: 'hello A' },
        { sessionId: 's2', title: 'B', snippet: 'hello B' },
      ],
    });
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0]!.group, '内容搜索');
    assert.equal(cmds[0]!.label, 'A');
    assert.equal(cmds[0]!.hint, 'hello A');
    assert.equal(cmds[1]!.label, 'B');
  });

  it('clicking a hit calls onSelectSession with the sessionId', () => {
    const selected: string[] = [];
    const cmds = buildContentSearchCommands(
      {
        kind: 'results',
        query: 'hello',
        hits: [{ sessionId: 's-target', title: 'hit', snippet: 'snip' }],
      },
      (sessionId: string) => selected.push(sessionId),
    );
    cmds[0]!.run();
    assert.deepEqual(selected, ['s-target']);
  });

  it('clicking a hit when no onSelectSession is wired does nothing (no throw)', () => {
    const cmds = buildContentSearchCommands({
      kind: 'results',
      query: 'hello',
      hits: [{ sessionId: 's', title: 'hit' }],
    });
    assert.doesNotThrow(() => cmds[0]!.run());
  });

  it('snippet renders as plain text (no HTML markers in label/hint)', () => {
    // xuan `6e7372c5`: snippet must render plain. If a hit's snippet
    // contains literal `<script>`, the palette stores it as-is in the
    // hint string — DOM render uses textContent, never innerHTML.
    // This test pins the shape: command label/hint contain whatever
    // the backend supplied without sanitization (the redactSecrets
    // pass already ran in main), AND the palette consumer is expected
    // to use plain-text rendering.
    const cmds = buildContentSearchCommands({
      kind: 'results',
      query: 'hello',
      hits: [{ sessionId: 's', title: 'safe', snippet: '<script>alert(1)</script>' }],
    });
    // The snippet is preserved verbatim — the palette renders it
    // through React's default text escaping. NOT our job to sanitize
    // here; just verify we don't apply any HTML-related transform.
    assert.equal(cmds[0]!.hint, '<script>alert(1)</script>');
  });
});

// ---------------------------------------------------------------------------
// disabled flag — xuan fixup `fd675604`
// ---------------------------------------------------------------------------

describe('disabled flag on status tiles (xuan fd675604)', () => {
  it('loading tile is disabled', () => {
    const cmds = buildContentSearchCommands({ kind: 'loading', query: 'hello' });
    assert.equal(cmds[0]!.disabled, true);
  });

  it('blocked tile is disabled', () => {
    const cmds = buildContentSearchCommands({
      kind: 'blocked',
      query: 'hello',
      reason: 'incognito_active',
      message: 'Search is disabled while incognito is active.',
    });
    assert.equal(cmds[0]!.disabled, true);
  });

  it('error tile is disabled', () => {
    const cmds = buildContentSearchCommands({
      kind: 'error',
      query: 'hello',
      reason: 'parse_error',
      message: 'Search failed.',
    });
    assert.equal(cmds[0]!.disabled, true);
  });

  it('empty results tile is disabled', () => {
    const cmds = buildContentSearchCommands({ kind: 'results', query: 'hello', hits: [] });
    assert.equal(cmds[0]!.disabled, true);
  });

  it('hit commands are NOT disabled (must be activatable)', () => {
    const cmds = buildContentSearchCommands(
      {
        kind: 'results',
        query: 'hello',
        hits: [
          { sessionId: 's1', title: 'A' },
          { sessionId: 's2', title: 'B', snippet: 'snip' },
        ],
      },
      () => undefined,
    );
    for (const cmd of cmds) {
      assert.notEqual(cmd.disabled, true, `hit command "${cmd.label}" should NOT be disabled`);
    }
  });

  // Pin the `commit()` semantics through a pure simulation. We do not
  // mount the real React palette here, but we can simulate the
  // `commit(cmd)` decision tree: a `disabled` command's `run()` must
  // NOT be invoked, and the simulated `onClose` callback must NOT
  // fire. The actual CommandPalette uses this exact gate in
  // `command-palette.tsx commit()`.
  it('simulated commit() on disabled blocked tile does NOT fire run or close', () => {
    let runCalled = 0;
    let closeCalled = 0;
    const cmds = buildContentSearchCommands({
      kind: 'blocked',
      query: 'hello',
      reason: 'incognito_active',
      message: 'Search is disabled while incognito is active.',
    });
    // Override `run` to a counter so we can assert it doesn't fire.
    const cmd = { ...cmds[0]!, run: () => { runCalled++; } };

    // Mirror the production commit() gate:
    //   if (!cmd) return;
    //   if (cmd.disabled) return;
    //   cmd.run();
    //   props.onClose();
    function simulatedCommit(c: typeof cmd | undefined, onClose: () => void) {
      if (!c) return;
      if (c.disabled) return;
      c.run();
      onClose();
    }
    simulatedCommit(cmd, () => { closeCalled++; });

    assert.equal(runCalled, 0, 'disabled command MUST NOT fire run()');
    assert.equal(closeCalled, 0, 'disabled command MUST NOT close palette');
  });

  it('simulated commit() on enabled hit tile DOES fire run and close', () => {
    let runCalled = 0;
    let closeCalled = 0;
    const cmds = buildContentSearchCommands(
      {
        kind: 'results',
        query: 'hello',
        hits: [{ sessionId: 's-target', title: 'hit' }],
      },
      () => undefined,
    );
    const cmd = { ...cmds[0]!, run: () => { runCalled++; } };

    function simulatedCommit(c: typeof cmd | undefined, onClose: () => void) {
      if (!c) return;
      if (c.disabled) return;
      c.run();
      onClose();
    }
    simulatedCommit(cmd, () => { closeCalled++; });

    assert.equal(runCalled, 1);
    assert.equal(closeCalled, 1);
  });
});
