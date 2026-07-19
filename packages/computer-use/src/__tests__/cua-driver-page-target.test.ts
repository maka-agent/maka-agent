import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CUA_INSPECT_PREPARED_ELEMENT_SCRIPT,
  buildCuaPrepareElementAtScreenPointScript,
  buildCuaSemanticPointerActionScript,
  parseCuaFocusedPageElement,
  parseCuaSemanticPointerResult,
  resolveCuaPageTextTarget,
  type CuaCdpPageTarget,
} from '../cua-driver-page-target.js';

const signal = new AbortController().signal;

function target(input: Partial<CuaCdpPageTarget> = {}): CuaCdpPageTarget {
  return {
    port: 9333,
    title: 'Window A',
    url: 'data:text/html,window-a#maka-a',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/a',
    ...input,
  };
}

describe('resolveCuaPageTextTarget', () => {
  it('selects the unique page whose title matches the resolved window', async () => {
    const resolved = await resolveCuaPageTextTarget(
      { pid: 42, windowTitle: 'Window B', signal },
      {
        listListeningPorts: async () => [9333],
        fetchTargets: async () => [
          target(),
          target({
            title: 'Window B',
            url: 'data:text/html,window-b#maka-b',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/b',
          }),
        ],
      },
    );

    assert.ok(resolved);
    assert.equal(resolved.port, 9333);
    assert.equal(resolved.targetUrlContains, '#maka-b');
  });

  it('fails closed when titles or URLs do not uniquely identify a page', async () => {
    const duplicateTitles = await resolveCuaPageTextTarget(
      { pid: 42, windowTitle: 'Window A', signal },
      {
        listListeningPorts: async () => [9333],
        fetchTargets: async () => [
          target(),
          target({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/b' }),
        ],
      },
    );
    assert.equal(duplicateTitles, undefined);

    const duplicateUrls = await resolveCuaPageTextTarget(
      { pid: 42, windowTitle: 'Window B', signal },
      {
        listListeningPorts: async () => [9333],
        fetchTargets: async () => [
          target(),
          target({
            title: 'Window B',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/b',
          }),
        ],
      },
    );
    assert.equal(duplicateUrls, undefined);
  });

  it('uses the only page target when the window title is unavailable', async () => {
    const resolved = await resolveCuaPageTextTarget(
      { pid: 42, signal },
      {
        listListeningPorts: async () => [9333],
        fetchTargets: async () => [target()],
      },
    );
    assert.equal(resolved?.targetUrlContains, '#maka-a');
  });
});

describe('semantic pointer action script', () => {
  it('builds coordinate-grounded click and range drag scripts', () => {
    const click = buildCuaSemanticPointerActionScript({
      type: 'left_click',
      screenPoint: { x: 200, y: 300 },
    });
    assert.match(click, /actionType = "left_click"/);
    assert.match(click, /elementFromPoint/);
    assert.match(click, /element\.click\(\)/);
    assert.match(click, /no_observable_effect/);
    assert.match(click, /textInputTypes/);

    const drag = buildCuaSemanticPointerActionScript({
      type: 'left_click_drag',
      startScreenPoint: { x: 10, y: 20 },
      endScreenPoint: { x: 100, y: 20 },
    });
    assert.match(drag, /type \|\| ''\)\.toLowerCase\(\) !== 'range'/);
    assert.match(drag, /dispatchEvent\(new Event\('input'/);
    assert.match(drag, /range_value_did_not_persist/);
    assert.match(drag, /unsupported_range_direction/);
  });

  it('builds read-only element scripts and parses their JSON result', () => {
    const prepare = buildCuaPrepareElementAtScreenPointScript({ x: 10, y: 20 });
    assert.match(prepare, /elementFromPoint/);
    assert.match(prepare, /__makaComputerUseTarget/);
    assert.doesNotMatch(prepare, /\.focus\s*\(/);
    assert.match(CUA_INSPECT_PREPARED_ELEMENT_SCRIPT, /__makaComputerUseReadElement/);
    assert.deepEqual(
      parseCuaFocusedPageElement(
        JSON.stringify({
          editable: true,
          value: 'ready',
          tagName: 'textarea',
        }),
      ),
      {
        editable: true,
        value: 'ready',
        tagName: 'textarea',
      },
    );
  });

  it('parses only explicit semantic pointer result objects', () => {
    assert.deepEqual(
      parseCuaSemanticPointerResult(
        JSON.stringify({
          supported: true,
          ok: true,
          kind: 'left_click',
          effect: 'mutation',
          clickEvents: 1,
          mutations: 1,
        }),
      ),
      {
        supported: true,
        ok: true,
        kind: 'left_click',
        effect: 'mutation',
        clickEvents: 1,
        mutations: 1,
      },
    );
    assert.equal(parseCuaSemanticPointerResult('not json'), undefined);
    assert.equal(parseCuaSemanticPointerResult('{}'), undefined);
  });
});
