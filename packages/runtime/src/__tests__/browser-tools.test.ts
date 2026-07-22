import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader } from '@maka/core';
import { PermissionEngine } from '../permission-engine.js';
import { ToolRuntime, type MakaTool, type MakaToolContext } from '../tool-runtime.js';
import {
  type BrowserBackend,
  type BrowserBackendOperations,
  type BrowserBackendInvocationAcquisition,
  type BrowserTarget,
  BrowserBackendError,
  boundBrowserSnapshotForWire,
  buildBrowserTools,
  MAX_BROWSER_ADDRESS_INPUT_CHARS,
  MAX_BROWSER_SELECTOR_CHARS,
  MAX_BROWSER_SNAPSHOT_CHARS,
  MAX_BROWSER_SNAPSHOT_ELEMENTS,
  MAX_BROWSER_TYPE_TEXT_UTF8_BYTES,
  MAX_BROWSER_URL_CHARS,
  MAX_BROWSER_WAIT_TEXT_UTF8_BYTES,
} from '../browser-tools.js';

function backend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    navigate: async ({ url }) => ({ url, title: '', takeoverReloaded: false }),
    snapshot: async () => ({
      url: '',
      elements: [{ text: '[1]<a href="/">Home</a>', ref: '[1]' }],
      totalElements: 1,
      takeoverReloaded: false,
    }),
    click: async () => ({ matches: 1, matchLevel: 'exact', takeoverReloaded: false }),
    type: async () => ({
      verified: true,
      actual: '',
      matchLevel: 'exact',
      takeoverReloaded: false,
    }),
    wait: async () => ({ takeoverReloaded: false }),
    extract: async ({ start }) => ({
      url: '',
      chunk: '',
      hasMore: false,
      nextStart: start,
      sourceTruncated: false,
      takeoverReloaded: false,
    }),
    releaseTurnState: async () => {},
    ...overrides,
  };
}

function backendOperations(
  overrides: Partial<BrowserBackendOperations> = {},
): BrowserBackendOperations {
  const source = backend(overrides);
  return {
    navigate: source.navigate,
    snapshot: source.snapshot,
    click: source.click,
    type: source.type,
    wait: source.wait,
    extract: source.extract,
  };
}

function context(
  operationId?: string,
  turnId = 't1',
  abortSignal = new AbortController().signal,
): MakaToolContext {
  return {
    sessionId: 's1',
    turnId,
    cwd: '/tmp',
    toolCallId: operationId ?? 'c1',
    ...(operationId ? { operationId } : {}),
    abortSignal,
    emitOutput: () => {},
  };
}

function named<P>(tools: MakaTool[], name: string): MakaTool<P, string> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool as MakaTool<P, string>;
}

async function run<P>(
  tools: MakaTool[],
  name: string,
  args: P,
  operationId?: string,
  turnId?: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const tool = named<P>(tools, name);
  const toolContext = context(operationId, turnId, abortSignal);
  const reservation = tool.reserveExecution?.(args, toolContext);
  try {
    const invoke = () => Promise.resolve(tool.impl(args, toolContext));
    return (await (reservation ? reservation.run(invoke) : invoke())) as string;
  } finally {
    reservation?.abandon();
  }
}

describe('Runtime browser tool contract', () => {
  it('owns the six schemas, browser permission category, and non-replay recovery policy', () => {
    const tools = buildBrowserTools({ backend: backend() });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_wait',
        'browser_extract',
      ],
    );
    assert.ok(tools.every((tool) => tool.categoryHint === 'browser'));
    assert.ok(tools.every((tool) => tool.recoveryMode === 'never_auto_retry'));

    const clickSchema = named<{ target: BrowserTarget }>(tools, 'browser_click').parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(clickSchema.safeParse({ target: { kind: 'ref', value: '[12]' } }).success, true);
    assert.equal(
      clickSchema.safeParse({ target: { kind: 'selector', value: 'button[type=submit]' } }).success,
      true,
    );
    assert.equal(clickSchema.safeParse({ target: '[12]' }).success, false);
    assert.equal(
      clickSchema.safeParse({ target: { kind: 'ref', value: '[0012]' } }).success,
      false,
    );
  });

  it('bounds every inline Browser input in both schemas and prepared intents', () => {
    const tools = buildBrowserTools({ backend: backend() });
    const typeTool = named<{
      target: BrowserTarget;
      text: string;
      submit?: boolean;
    }>(tools, 'browser_type');
    const waitTool = named<{
      text?: string;
      selector?: string;
      time?: number;
      timeout?: number;
    }>(tools, 'browser_wait');
    const extractTool = named<{ selector?: string; start?: number }>(tools, 'browser_extract');
    const typeSchema = typeTool.parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    const waitSchema = waitTool.parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    const extractSchema = extractTool.parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    const target = { kind: 'selector', value: '#query' } as const;
    const maxUtf8Text =
      '你'.repeat(Math.floor(MAX_BROWSER_TYPE_TEXT_UTF8_BYTES / 3)) +
      'x'.repeat(MAX_BROWSER_TYPE_TEXT_UTF8_BYTES % 3);
    assert.equal(Buffer.byteLength(maxUtf8Text, 'utf8'), MAX_BROWSER_TYPE_TEXT_UTF8_BYTES);
    assert.equal(typeSchema.safeParse({ target, text: maxUtf8Text }).success, true);
    assert.equal(typeSchema.safeParse({ target, text: `${maxUtf8Text}你` }).success, false);

    const maxSelector = `#${'x'.repeat(MAX_BROWSER_SELECTOR_CHARS - 1)}`;
    assert.equal(waitSchema.safeParse({ selector: maxSelector }).success, true);
    assert.equal(waitSchema.safeParse({ selector: `${maxSelector}x` }).success, false);
    assert.equal(extractSchema.safeParse({ selector: maxSelector }).success, true);
    assert.equal(extractSchema.safeParse({ selector: `${maxSelector}x` }).success, false);
    assert.equal(
      waitSchema.safeParse({ text: 'x'.repeat(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES) }).success,
      true,
    );
    assert.equal(
      waitSchema.safeParse({ text: 'x'.repeat(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES + 1) }).success,
      false,
    );
    assert.equal(
      waitSchema.safeParse({
        text: '你'.repeat(Math.floor(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES / 3) + 1),
      }).success,
      false,
    );

    const intentContext = { sessionId: 's1', turnId: 't1', toolCallId: 'c1' };
    assert.deepEqual(typeTool.prepareIntentArgs?.({ target, text: 'ok' }, intentContext), {
      target,
      text: 'ok',
      submit: false,
    });
    assert.deepEqual(waitTool.prepareIntentArgs?.({ text: 'Ready', timeout: 999 }, intentContext), {
      text: 'Ready',
      timeout: 120,
    });
    assert.throws(() =>
      typeTool.prepareIntentArgs?.({ target, text: `${maxUtf8Text}你` }, intentContext),
    );
    assert.throws(() =>
      waitTool.prepareIntentArgs?.(
        { text: 'x'.repeat(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES + 1) },
        intentContext,
      ),
    );
    assert.throws(() =>
      extractTool.prepareIntentArgs?.({ selector: `${maxSelector}x` }, intentContext),
    );
  });

  it('enforces the canonical escaped review budget before permission and backend dispatch', async () => {
    type BoundaryCase = {
      name: 'browser_type' | 'browser_wait';
      args: unknown;
      expectedReview?: unknown;
      expectedBackendText?: string;
    };
    const executeBoundary = async (testCase: BoundaryCase): Promise<void> => {
      const backendTexts: string[] = [];
      const permissionRequests: Array<Extract<SessionEvent, { type: 'permission_request' }>> = [];
      let resolvePermission!: (
        event: Extract<SessionEvent, { type: 'permission_request' }>,
      ) => void;
      const permissionRequested = new Promise<
        Extract<SessionEvent, { type: 'permission_request' }>
      >((resolve) => {
        resolvePermission = resolve;
      });
      const tools = buildBrowserTools({
        backend: backend({
          type: async ({ text }) => {
            backendTexts.push(text);
            return {
              verified: true,
              actual: text,
              matchLevel: 'exact',
              takeoverReloaded: false,
            };
          },
          wait: async ({ condition }) => {
            if (condition.kind === 'text') backendTexts.push(condition.value);
            return { takeoverReloaded: false };
          },
        }),
      });
      const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
      permissionEngine.beginTurn('turn-1');
      const runtime = new ToolRuntime({
        execution: { kind: 'embedded', getCurrentRunId: () => undefined },
        sessionId: 'session-1',
        header: runtimeHeader(),
        connection: runtimeConnection(),
        modelId: 'model-1',
        appendMessage: async () => {},
        permissionEngine,
        newId: nextId(),
        now: () => 1,
        getPermissionPauseTarget: () => null,
      });
      const pending = runtime.wrapToolExecute(
        { ...named<unknown>(tools, testCase.name), permissionRequired: true },
        'turn-1',
        {
          push: (event) => {
            if (event.type !== 'permission_request') return;
            permissionRequests.push(event);
            resolvePermission(event);
            if (testCase.expectedReview === undefined) {
              queueMicrotask(() => {
                permissionEngine.recordResponse('turn-1', {
                  requestId: event.requestId,
                  decision: 'deny',
                });
              });
            }
          },
        },
      )(testCase.args, {
        toolCallId: `boundary-${testCase.name}`,
        abortSignal: new AbortController().signal,
      });
      pending.catch(() => {});

      if (testCase.expectedReview === undefined) {
        await assert.rejects(pending);
        assert.equal(permissionRequests.length, 0);
        assert.deepEqual(backendTexts, []);
      } else {
        const request = await permissionRequested;
        assert.deepEqual(request.review, testCase.expectedReview);
        assert.deepEqual(backendTexts, []);
        permissionEngine.recordResponse('turn-1', {
          requestId: request.requestId,
          decision: 'allow',
        });
        await pending;
        assert.deepEqual(backendTexts, [testCase.expectedBackendText]);
      }
      permissionEngine.endTurn('turn-1');
    };

    const exactBackslashes = '\\'.repeat(MAX_BROWSER_TYPE_TEXT_UTF8_BYTES / 2);
    const exactUnsafe = '\u0000'.repeat(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES / 8);
    await executeBoundary({
      name: 'browser_type',
      args: { target: { kind: 'selector', value: '#query' }, text: exactBackslashes },
      expectedReview: {
        kind: 'browser',
        action: 'type',
        ref: '#query',
        text: '\\\\'.repeat(MAX_BROWSER_TYPE_TEXT_UTF8_BYTES / 2),
        submit: false,
      },
      expectedBackendText: exactBackslashes,
    });
    await executeBoundary({
      name: 'browser_type',
      args: {
        target: { kind: 'selector', value: '#query' },
        text: `${exactBackslashes}\\`,
      },
    });
    await executeBoundary({
      name: 'browser_wait',
      args: { text: exactUnsafe },
      expectedReview: {
        kind: 'browser',
        action: 'wait',
        condition: 'text',
        value: '\\u{0000}'.repeat(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES / 8),
        timeoutSeconds: 30,
      },
      expectedBackendText: exactUnsafe,
    });
    await executeBoundary({
      name: 'browser_wait',
      args: { text: `${exactUnsafe}\u0000` },
    });
  });

  it('projects canonical Browser args through ToolRuntime storage, events, and permission review', async () => {
    const clickReviews: unknown[] = [];
    let seenTarget: BrowserTarget | undefined;
    let resolvePermission!: (event: Extract<SessionEvent, { type: 'permission_request' }>) => void;
    const permissionRequested = new Promise<Extract<SessionEvent, { type: 'permission_request' }>>(
      (resolve) => {
        resolvePermission = resolve;
      },
    );
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const runtime = new ToolRuntime({
      execution: { kind: 'embedded', getCurrentRunId: () => undefined },
      sessionId: 'session-1',
      header: runtimeHeader(),
      connection: runtimeConnection(),
      modelId: 'model-1',
      appendMessage: async (message) => {
        if (message.type === 'tool_call') clickReviews.push(message.review);
      },
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const click = named<{ target: BrowserTarget }>(
      buildBrowserTools({
        backend: backend({
          click: async ({ target }) => {
            seenTarget = target;
            return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
          },
        }),
      }),
      'browser_click',
    );
    const pending = runtime.wrapToolExecute(click, 'turn-1', {
      push: (event) => {
        if (event.type === 'tool_start') clickReviews.push(event.review);
        if (event.type === 'permission_request') {
          clickReviews.push(event.review);
          resolvePermission(event);
        }
      },
    })(
      { target: { kind: 'selector', value: '#confirm' } },
      { toolCallId: 'browser-call-1', abortSignal: new AbortController().signal },
    );
    pending.catch(() => {});
    const request = await permissionRequested;
    permissionEngine.recordResponse('turn-1', {
      requestId: request.requestId,
      decision: 'allow',
    });
    await pending;

    const expectedClick = {
      kind: 'browser',
      action: 'click',
      ref: '#confirm',
    };
    assert.deepEqual(clickReviews, [expectedClick, expectedClick, expectedClick]);
    assert.deepEqual(seenTarget, { kind: 'selector', value: '#confirm' });

    const waitReviews: unknown[] = [];
    let seenWait: unknown;
    const wait = named<{ text?: string; selector?: string; time?: number; timeout?: number }>(
      buildBrowserTools({
        backend: backend({
          wait: async ({ condition }) => {
            seenWait = condition;
            return { takeoverReloaded: false };
          },
        }),
      }),
      'browser_wait',
    );
    await runtime.wrapToolExecute({ ...wait, permissionRequired: false }, 'turn-1', {
      push: (event) => {
        if (event.type === 'tool_start') waitReviews.push(event.review);
      },
    })(
      { text: 'Ready', timeout: 999 },
      { toolCallId: 'browser-call-2', abortSignal: new AbortController().signal },
    );
    const expectedWait = {
      kind: 'browser',
      action: 'wait',
      condition: 'text',
      value: 'Ready',
      timeoutSeconds: 120,
    };
    assert.deepEqual(waitReviews, [expectedWait]);
    assert.deepEqual(seenWait, { kind: 'text', value: 'Ready', timeoutSeconds: 120 });
    permissionEngine.endTurn('turn-1');
  });

  it('does not read accessor-backed args during Browser execution reservation', async () => {
    let getterReads = 0;
    let backendDispatches = 0;
    let permissionEvents = 0;
    const tools = buildBrowserTools({
      backend: backend({
        click: async () => {
          backendDispatches += 1;
          return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
        },
      }),
    });
    const click = named<unknown>(tools, 'browser_click');
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const runtime = new ToolRuntime({
      execution: { kind: 'embedded', getCurrentRunId: () => undefined },
      sessionId: 'session-1',
      header: runtimeHeader(),
      connection: runtimeConnection(),
      modelId: 'model-1',
      appendMessage: async () => {},
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const events = {
      push(event: SessionEvent) {
        if (event.type !== 'permission_request') return;
        permissionEvents += 1;
        queueMicrotask(() => {
          permissionEngine.recordResponse('turn-1', {
            requestId: event.requestId,
            decision: 'deny',
          });
        });
      },
    };
    const execute = (tool: MakaTool, args: unknown) =>
      runtime.wrapToolExecute(
        tool,
        'turn-1',
        events,
      )(args, {
        toolCallId: 'accessor-call',
        abortSignal: new AbortController().signal,
      });
    const accessorArgs = Object.defineProperty({}, 'target', {
      enumerable: true,
      get() {
        getterReads += 1;
        return { kind: 'ref', value: '[1]' };
      },
    });

    await assert.rejects(execute(click, accessorArgs));
    assert.equal(getterReads, 0);
    assert.equal(permissionEvents, 0);
    assert.equal(backendDispatches, 0);

    await execute(
      { ...click, permissionRequired: false },
      {
        target: { kind: 'selector', value: '#safe' },
      },
    );
    assert.equal(getterReads, 0);
    assert.equal(permissionEvents, 0);
    assert.equal(backendDispatches, 1);
    permissionEngine.endTurn('turn-1');
  });

  it('normalizes navigation before backend dispatch and reports landed URL/title', async () => {
    let dispatched = '';
    const tools = buildBrowserTools({
      backend: backend({
        navigate: async ({ url }) => {
          dispatched = url;
          return { url: 'https://example.com/welcome', title: 'Welcome', takeoverReloaded: false };
        },
      }),
    });
    const output = await run(tools, 'browser_navigate', { url: 'https://example.com' });
    assert.equal(dispatched, 'https://example.com/');
    assert.match(output, /Loaded https:\/\/example\.com\/welcome/);
    assert.match(output, /Title: Welcome/);
    await assert.rejects(
      run(tools, 'browser_navigate', { url: 'file:///etc/passwd' }),
      /Not a navigable URL/,
    );
  });

  it('admits a 4000-character raw address whose canonical wire URL is 4009 characters', async () => {
    const raw = `example.com?${'a'.repeat(MAX_BROWSER_ADDRESS_INPUT_CHARS - 12)}`;
    let dispatched = '';
    const tools = buildBrowserTools({
      backend: backend({
        navigate: async ({ url }) => {
          dispatched = url;
          return { url, title: '', takeoverReloaded: false };
        },
      }),
    });
    const navigate = named<{ url: string }>(tools, 'browser_navigate');
    const schema = navigate.parameters as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(raw.length, MAX_BROWSER_ADDRESS_INPUT_CHARS);
    assert.equal(schema.safeParse({ url: raw }).success, true);
    const prepared = navigate.prepareIntentArgs?.(
      { url: raw },
      { sessionId: 's1', turnId: 't1', toolCallId: 'c1' },
    ) as { url: string };
    assert.equal(prepared.url.length, MAX_BROWSER_URL_CHARS);
    await run(tools, 'browser_navigate', { url: raw });
    assert.equal(dispatched, prepared.url);
  });

  it('uses the explicit target union and preserves click/type/takeover projections', async () => {
    const seen: BrowserTarget[] = [];
    const tools = buildBrowserTools({
      backend: backend({
        snapshot: async () => ({
          url: '',
          elements: [
            { text: '[5]<button>Click</button>', ref: '[5]' },
            { text: '[7]<input name="Name" />', ref: '[7]' },
          ],
          totalElements: 2,
          takeoverReloaded: false,
        }),
        click: async ({ target }) => {
          seen.push(target);
          return { matches: 3, matchLevel: 'stable', takeoverReloaded: true };
        },
        type: async ({ target }) => {
          seen.push(target);
          return {
            verified: false,
            actual: 'partial',
            matchLevel: 'exact',
            takeoverReloaded: false,
          };
        },
      }),
    });
    await run(tools, 'browser_snapshot', {});
    const typed = await run(tools, 'browser_type', {
      target: { kind: 'ref', value: '[7]' },
      text: 'hello',
      submit: true,
    });
    assert.match(typed, /then pressed Enter/);
    assert.match(typed, /Not verified/);
    assert.match(typed, /"partial"/);
    const click = await run(tools, 'browser_click', { target: { kind: 'ref', value: '[5]' } });
    assert.match(click, /matched 3 elements, stable match/);
    assert.match(click, /Multiple matches/);
    assert.match(click, /reloaded once/);
    assert.deepEqual(seen, [
      { kind: 'ref', value: '[7]' },
      { kind: 'ref', value: '[5]' },
    ]);
  });

  it('invalidates old refs before navigate dispatch even when its outcome is unknown', async () => {
    let clickCalls = 0;
    const tools = buildBrowserTools({
      backend: backend({
        navigate: async () => {
          throw Object.assign(new Error('navigation reply was lost'), {
            code: 'outcome_unknown',
          });
        },
        click: async () => {
          clickCalls += 1;
          return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
        },
      }),
    });
    await run(tools, 'browser_snapshot', {});
    await assert.rejects(
      run(tools, 'browser_navigate', { url: 'https://example.com/next' }),
      (error: unknown) =>
        error instanceof BrowserBackendError &&
        error.code === 'outcome_unknown' &&
        /outcome_unknown/.test(error.message),
    );
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } }),
      /successful browser_snapshot in the same Turn/,
    );
    assert.equal(clickCalls, 0);
    await run(tools, 'browser_click', { target: { kind: 'selector', value: '#still-valid' } });
    assert.equal(clickCalls, 1, 'selector targets do not depend on snapshot provenance');
  });

  it('publishes only producer-authorized snapshot ref metadata', async () => {
    const targets: BrowserTarget[] = [];
    let acquisitions = 0;
    const operations = backendOperations({
      snapshot: async () => ({
        url: '',
        elements: [
          { text: '    [1]<button type="submit">Save</button>', ref: '[1]' },
          { text: '  *[2]<input name="query" />', ref: '[2]' },
          { text: '      [3]<svg aria-label="Menu" />', ref: '[3]' },
          {
            text: '  *|scroll[4]|<div role="button" /> (0.0\u2191 1.0\u2193)',
            ref: '[4]',
          },
          { text: '  [201]<button>not actionable</button>' },
        ],
        totalElements: 5,
        takeoverReloaded: false,
      }),
      click: async ({ target }) => {
        targets.push(target);
        return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
      },
      type: async ({ target, text }) => {
        targets.push(target);
        return {
          verified: true,
          actual: text,
          matchLevel: 'exact',
          takeoverReloaded: false,
        };
      },
    });
    const tools = buildBrowserTools({
      invocationProvider: {
        acquire: async () => {
          acquisitions += 1;
          return {
            ok: true,
            invocation: {
              backend: operations,
              affinity: 'A',
              release: () => {},
            },
          };
        },
      },
    });

    const output = await run(tools, 'browser_snapshot', {}, 'grammar-snapshot');
    assert.match(output, /^  \[201\]<button>not actionable<\/button>$/m);
    await run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } }, 'grammar-click');
    await run(
      tools,
      'browser_type',
      { target: { kind: 'ref', value: '[2]' }, text: 'query' },
      'grammar-type',
    );
    await run(tools, 'browser_click', { target: { kind: 'ref', value: '[3]' } }, 'grammar-svg');
    await run(tools, 'browser_click', { target: { kind: 'ref', value: '[4]' } }, 'grammar-scroll');
    const acquisitionsBeforeFakeRef = acquisitions;
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[201]' } }, 'fake-click'),
      /ref visible/,
    );
    await assert.rejects(
      run(
        tools,
        'browser_type',
        { target: { kind: 'ref', value: '[201]' }, text: 'blocked' },
        'fake-type',
      ),
      /ref visible/,
    );
    assert.equal(acquisitions, acquisitionsBeforeFakeRef);
    assert.deepEqual(targets, [
      { kind: 'ref', value: '[1]' },
      { kind: 'ref', value: '[2]' },
      { kind: 'ref', value: '[3]' },
      { kind: 'ref', value: '[4]' },
    ]);
  });

  it('fails closed on malformed, mismatched, duplicate, or inexact snapshot ref metadata', async () => {
    const invalidEntries: readonly unknown[][] = [
      [{ text: '[1]<button />', ref: '[01]' }],
      [{ text: '[1]<button />', ref: '[2]' }],
      [
        { text: '[1]<button>first</button>', ref: '[1]' },
        { text: '[1]<button>second</button>', ref: '[1]' },
      ],
      [{ text: '[1]<button />', ref: '[1]', extra: true }],
    ];

    for (const elements of invalidEntries) {
      const tools = buildBrowserTools({
        backend: backend({
          snapshot: async () => ({
            url: '',
            elements: elements as never,
            totalElements: elements.length,
            takeoverReloaded: false,
          }),
        }),
      });
      await assert.rejects(
        run(tools, 'browser_snapshot', {}),
        /Invalid Browser snapshot backend result/,
      );
    }
  });

  it('bounds snapshot projection by element count with an explicit marker', async () => {
    const elements = Array.from({ length: MAX_BROWSER_SNAPSHOT_ELEMENTS + 20 }, (_, index) => ({
      text: `[${index + 1}] button "item"`,
    }));
    const bounded = boundBrowserSnapshotForWire({
      url: 'https://example.com/',
      elements,
      takeoverReloaded: true,
    });
    assert.equal(bounded.elements.length, MAX_BROWSER_SNAPSHOT_ELEMENTS);
    assert.equal(bounded.totalElements, elements.length);
    const tools = buildBrowserTools({
      backend: backend({
        snapshot: async () => bounded,
      }),
    });
    const output = await run(tools, 'browser_snapshot', {});
    assert.ok(
      output.length <= MAX_BROWSER_SNAPSHOT_CHARS,
      `${output.length} exceeds snapshot limit`,
    );
    assert.match(output, /browser_snapshot truncated/);
    assert.match(output, /showing 200 of 220 elements/);
    assert.match(output, /reloaded once/);
    assert.doesNotMatch(output, /\[201\] button/);
  });

  it('keeps snapshot entries whole when the character budget truncates before the next element', async () => {
    const elements = [
      { text: '[1]<button>first</button>', ref: '[1]' as const },
      {
        text: `[2]<button>${'x'.repeat(MAX_BROWSER_SNAPSHOT_CHARS)}</button>`,
        ref: '[2]' as const,
      },
      { text: '[3]<a>last</a>', ref: '[3]' as const },
    ];
    const bounded = boundBrowserSnapshotForWire({
      url: 'https://example.com/',
      elements,
      takeoverReloaded: true,
    });
    assert.deepEqual(bounded.elements, [{ text: '[1]<button>first</button>', ref: '[1]' }]);
    assert.equal(bounded.totalElements, 3);
    const tools = buildBrowserTools({
      backend: backend({
        snapshot: async () => bounded,
      }),
    });
    const output = await run(tools, 'browser_snapshot', {});
    assert.ok(output.length <= MAX_BROWSER_SNAPSHOT_CHARS);
    assert.match(output, /\[1\]<button>first<\/button>/);
    assert.match(output, /showing 1 of 3 elements/);
    assert.doesNotMatch(output, /\[2\]<button>/);
    assert.doesNotMatch(output, /\[3\]<a>/);
    assert.match(output, /reloaded once/);
  });

  it('rejects a snapshot ref hidden by projection bounds before backend acquisition', async () => {
    const snapshot = boundBrowserSnapshotForWire({
      url: 'https://example.com/',
      elements: Array.from({ length: MAX_BROWSER_SNAPSHOT_ELEMENTS + 1 }, (_, index) => ({
        text: `[${index + 1}]<button>item</button>`,
        ref: `[${index + 1}]` as `[${string}]`,
      })),
      takeoverReloaded: false,
    });
    let acquisitions = 0;
    let clickDispatches = 0;
    const tools = buildBrowserTools({
      invocationProvider: {
        acquire: async () => {
          acquisitions += 1;
          return {
            ok: true,
            invocation: {
              affinity: 'A',
              backend: backendOperations({
                snapshot: async () => snapshot,
                click: async () => {
                  clickDispatches += 1;
                  return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
                },
              }),
              release: () => {},
            },
          };
        },
      },
    });

    const output = await run(tools, 'browser_snapshot', {}, 'snapshot');
    assert.doesNotMatch(output, /\[201\]<button>/);
    const acquisitionsBeforeClick = acquisitions;
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[201]' } }, 'hidden-ref'),
      /ref visible/,
    );
    assert.equal(acquisitions, acquisitionsBeforeClick);
    assert.equal(clickDispatches, 0);
  });

  it('invalidates snapshot A refs when snapshot B is admitted ahead of an old-ref action', async () => {
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const acquisitions: string[] = [];
    const dispatches: string[] = [];
    let snapshotNumber = 0;
    const tools = buildBrowserTools({
      invocationProvider: {
        acquire: async ({ context: invoked }) => {
          acquisitions.push(invoked.toolCallId);
          return {
            ok: true,
            invocation: {
              affinity: 'A',
              backend: backendOperations({
                snapshot: async (_signal, context) => {
                  snapshotNumber += 1;
                  dispatches.push(`snapshot:${context.toolCallId}`);
                  return {
                    url: '',
                    elements: [
                      { text: `[1]<button>snapshot ${snapshotNumber}</button>`, ref: '[1]' },
                    ],
                    totalElements: 1,
                    takeoverReloaded: false,
                  };
                },
                wait: async (_input, _signal, context) => {
                  dispatches.push(`wait:${context.toolCallId}`);
                  await waitGate;
                  return { takeoverReloaded: false };
                },
                click: async (_input, _signal, context) => {
                  dispatches.push(`click:${context.toolCallId}`);
                  return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
                },
              }),
              release: () => {},
            },
          };
        },
      },
    });

    await run(tools, 'browser_snapshot', {}, 'snapshot-a');
    const blocker = run(tools, 'browser_wait', { time: 1 }, 'blocker');
    const snapshotB = run(tools, 'browser_snapshot', {}, 'snapshot-b');
    const oldRef = run(
      tools,
      'browser_click',
      { target: { kind: 'ref', value: '[1]' } },
      'old-ref',
    );
    oldRef.catch(() => {});
    releaseWait();

    await Promise.all([blocker, snapshotB]);
    await assert.rejects(oldRef, /ref visible/);
    assert.deepEqual(dispatches, ['snapshot:snapshot-a', 'wait:blocker', 'snapshot:snapshot-b']);
    assert.deepEqual(acquisitions, ['snapshot-a', 'blocker', 'snapshot-b']);
  });

  it('rejects an unbounded snapshot backend result instead of silently cropping it', async () => {
    const elements = Array.from({ length: MAX_BROWSER_SNAPSHOT_ELEMENTS + 1 }, (_, index) => ({
      text: `[${index + 1}] button "item"`,
    }));
    const tools = buildBrowserTools({
      backend: backend({
        snapshot: async () => ({
          url: '',
          elements,
          totalElements: elements.length,
          takeoverReloaded: false,
        }),
      }),
    });
    await assert.rejects(run(tools, 'browser_snapshot', {}), /snapshot.*elements/i);
  });

  it('validates and canonicalizes wait conditions before dispatch', async () => {
    const conditions: unknown[] = [];
    const tools = buildBrowserTools({
      backend: backend({
        wait: async ({ condition }) => {
          conditions.push(condition);
          return { takeoverReloaded: false };
        },
      }),
    });
    await assert.rejects(run(tools, 'browser_wait', {}), /exactly one/);
    await assert.rejects(run(tools, 'browser_wait', { text: 'a', time: 1 }), /exactly one/);
    await assert.rejects(run(tools, 'browser_wait', { selector: '   ' }), /non-empty/);
    const output = await run(tools, 'browser_wait', { text: 'Loaded', timeout: 999 });
    assert.match(output, /Done: text "Loaded"/);
    assert.deepEqual(conditions, [{ kind: 'text', value: 'Loaded', timeoutSeconds: 120 }]);
  });

  it('passes canonical extraction pagination to the backend and owns continuation projection', async () => {
    const requests: unknown[] = [];
    const tools = buildBrowserTools({
      backend: backend({
        extract: async (input) => {
          requests.push(input);
          return {
            url: 'https://example.com/',
            chunk: 'a'.repeat(input.limit),
            hasMore: true,
            nextStart: input.start + input.limit,
            sourceTruncated: true,
            takeoverReloaded: false,
          };
        },
      }),
    });
    const output = await run(tools, 'browser_extract', { selector: 'main', start: 12.9 });
    assert.deepEqual(requests, [{ selector: 'main', start: 12, limit: 16_000 }]);
    assert.match(output, /next_start_char: 16012/);
    assert.match(output, /HTML was larger than the extraction ceiling/);
  });

  it('fails closed on malformed counts and oversized UTF-8 backend text', async () => {
    const invalidCount = buildBrowserTools({
      backend: backend({
        click: async () => ({
          matches: Number.NaN,
          matchLevel: 'exact',
          takeoverReloaded: false,
        }),
      }),
    });
    await assert.rejects(
      run(invalidCount, 'browser_click', {
        target: { kind: 'selector', value: '#submit' },
      }),
      /matches must be a non-negative safe integer/,
    );

    const invalidActual = buildBrowserTools({
      backend: backend({
        type: async () => ({
          verified: false,
          actual: '你'.repeat(Math.floor(MAX_BROWSER_TYPE_TEXT_UTF8_BYTES / 3) + 1),
          matchLevel: 'exact',
          takeoverReloaded: false,
        }),
      }),
    });
    await assert.rejects(
      run(invalidActual, 'browser_type', {
        target: { kind: 'selector', value: '#query' },
        text: 'ok',
      }),
      new RegExp(`actual exceeds ${MAX_BROWSER_TYPE_TEXT_UTF8_BYTES} UTF-8 bytes`),
    );
  });

  it('rejects extraction pages that exceed the request or corrupt continuation offsets', async () => {
    let corruptOffset = false;
    const tools = buildBrowserTools({
      backend: backend({
        extract: async ({ start, limit }) => {
          const chunk = corruptOffset ? 'ok' : 'x'.repeat(limit + 1);
          return {
            url: '',
            chunk,
            hasMore: true,
            nextStart: start + chunk.length + (corruptOffset ? 1 : 0),
            sourceTruncated: false,
            takeoverReloaded: false,
          };
        },
      }),
    });
    await assert.rejects(run(tools, 'browser_extract', {}), /chunk exceeds 16000 characters/);
    corruptOffset = true;
    await assert.rejects(
      run(tools, 'browser_extract', { start: 20 }),
      /nextStart does not continue from the requested start/,
    );
  });

  it('releases local state with explicit Session and Turn identity', async () => {
    const released: unknown[] = [];
    const tools = buildBrowserTools({
      backend: backend({
        releaseTurnState: async (input) => {
          released.push(input);
        },
      }),
    });
    await tools.releaseTurnState({ sessionId: 's1', turnId: 't1' });
    assert.deepEqual(released, [{ sessionId: 's1', turnId: 't1' }]);
  });

  it('reserves Browser FIFO before ToolRuntime persistence and permission awaits', async () => {
    const dispatches: string[] = [];
    const tools = buildBrowserTools({
      backend: backend({
        navigate: async ({ url }, _signal, invoked) => {
          dispatches.push(`navigate:${invoked.toolCallId}`);
          return { url, title: '', takeoverReloaded: false };
        },
        snapshot: async (_signal, invoked) => {
          dispatches.push(`snapshot:${invoked.toolCallId}`);
          return {
            url: '',
            elements: [{ text: '[1]<button />', ref: '[1]' }],
            totalElements: 1,
            takeoverReloaded: false,
          };
        },
        click: async ({ target }, _signal, invoked) => {
          dispatches.push(`click:${invoked.toolCallId}:${target.value}`);
          return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
        },
        wait: async (_input, _signal, invoked) => {
          dispatches.push(`wait:${invoked.toolCallId}`);
          return { takeoverReloaded: false };
        },
      }),
    });

    let releaseNavigatePersistence!: () => void;
    const navigatePersistenceGate = new Promise<void>((resolve) => {
      releaseNavigatePersistence = resolve;
    });
    let blockNavigatePersistence = false;
    const persistedCalls = new Set<string>();
    let markConcurrentCallsPersisted!: () => void;
    const concurrentCallsPersisted = new Promise<void>((resolve) => {
      markConcurrentCallsPersisted = resolve;
    });
    type PermissionRequest = Extract<SessionEvent, { type: 'permission_request' }>;
    const permissionRequests: PermissionRequest[] = [];
    const permissionWaiters: Array<(request: PermissionRequest) => void> = [];
    const nextPermissionRequest = (): Promise<PermissionRequest> => {
      const available = permissionRequests.shift();
      if (available) return Promise.resolve(available);
      return new Promise((resolve) => permissionWaiters.push(resolve));
    };
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const runtime = new ToolRuntime({
      execution: { kind: 'embedded', getCurrentRunId: () => undefined },
      sessionId: 's1',
      header: runtimeHeader(),
      connection: runtimeConnection(),
      modelId: 'model-1',
      appendMessage: async (message) => {
        if (message.type !== 'tool_call') return;
        persistedCalls.add(message.id);
        if (
          ['navigate', 'new-snapshot', 'old-ref', 'canceled'].every((id) => persistedCalls.has(id))
        ) {
          markConcurrentCallsPersisted();
        }
        if (blockNavigatePersistence && message.id === 'navigate') {
          await navigatePersistenceGate;
        }
      },
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const events = {
      push(event: SessionEvent) {
        if (event.type !== 'permission_request') return;
        const waiter = permissionWaiters.shift();
        if (waiter) waiter(event);
        else permissionRequests.push(event);
      },
    };
    const execute = (
      name: string,
      args: unknown,
      toolCallId: string,
      options: { permission?: boolean; signal?: AbortSignal } = {},
    ) => {
      const source = named<unknown>(tools, name);
      const tool = options.permission ? source : { ...source, permissionRequired: false };
      return runtime.wrapToolExecute(
        tool,
        'turn-1',
        events,
      )(args, {
        toolCallId,
        abortSignal: options.signal ?? new AbortController().signal,
      });
    };

    await execute('browser_snapshot', {}, 'baseline-snapshot');

    const denied = execute('browser_wait', { time: 1 }, 'denied-wait', { permission: true });
    const afterDenied = execute('browser_snapshot', {}, 'after-denied');
    const deniedRequest = await nextPermissionRequest();
    permissionEngine.recordResponse('turn-1', {
      requestId: deniedRequest.requestId,
      decision: 'deny',
    });
    await Promise.all([denied, afterDenied]);
    assert.deepEqual(dispatches, ['snapshot:baseline-snapshot', 'snapshot:after-denied']);

    blockNavigatePersistence = true;
    const navigate = execute('browser_navigate', { url: 'https://example.com/next' }, 'navigate', {
      permission: true,
    });
    const newSnapshot = execute('browser_snapshot', {}, 'new-snapshot');
    const oldRef = execute('browser_click', { target: { kind: 'ref', value: '[1]' } }, 'old-ref');
    const canceledController = new AbortController();
    const canceled = execute(
      'browser_click',
      { target: { kind: 'selector', value: '#canceled' } },
      'canceled',
      { signal: canceledController.signal },
    );
    await concurrentCallsPersisted;
    canceledController.abort();
    assert.deepEqual(dispatches, ['snapshot:baseline-snapshot', 'snapshot:after-denied']);

    releaseNavigatePersistence();
    const navigateRequest = await nextPermissionRequest();
    assert.deepEqual(dispatches, ['snapshot:baseline-snapshot', 'snapshot:after-denied']);
    permissionEngine.recordResponse('turn-1', {
      requestId: navigateRequest.requestId,
      decision: 'allow',
    });
    await Promise.all([navigate, newSnapshot, oldRef, canceled]);
    assert.deepEqual(dispatches, [
      'snapshot:baseline-snapshot',
      'snapshot:after-denied',
      'navigate:navigate',
      'snapshot:new-snapshot',
    ]);

    await execute('browser_click', { target: { kind: 'ref', value: '[1]' } }, 'fresh-ref');
    assert.equal(dispatches.at(-1), 'click:fresh-ref:[1]');
    permissionEngine.endTurn('turn-1');
  });

  it('keeps a ref action valid when a later reserved navigate advances provenance', async () => {
    const dispatches: string[] = [];
    const tools = buildBrowserTools({
      backend: backend({
        snapshot: async (_signal, invoked) => {
          dispatches.push(`snapshot:${invoked.toolCallId}`);
          return {
            url: '',
            elements: [{ text: '[1]<button />', ref: '[1]' }],
            totalElements: 1,
            takeoverReloaded: false,
          };
        },
        click: async (_input, _signal, invoked) => {
          dispatches.push(`click:${invoked.toolCallId}`);
          return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
        },
        navigate: async ({ url }, _signal, invoked) => {
          dispatches.push(`navigate:${invoked.toolCallId}`);
          return { url, title: '', takeoverReloaded: false };
        },
      }),
    });
    let releaseClickPersistence!: () => void;
    const clickPersistenceGate = new Promise<void>((resolve) => {
      releaseClickPersistence = resolve;
    });
    let markClickPersistenceStarted!: () => void;
    const clickPersistenceStarted = new Promise<void>((resolve) => {
      markClickPersistenceStarted = resolve;
    });
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const runtime = new ToolRuntime({
      execution: { kind: 'embedded', getCurrentRunId: () => undefined },
      sessionId: 's1',
      header: runtimeHeader(),
      connection: runtimeConnection(),
      modelId: 'model-1',
      appendMessage: async (message) => {
        if (message.type === 'tool_call' && message.id === 'earlier-ref') {
          markClickPersistenceStarted();
          await clickPersistenceGate;
        }
      },
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const execute = (name: string, args: unknown, toolCallId: string) =>
      runtime.wrapToolExecute(
        { ...named<unknown>(tools, name), permissionRequired: false },
        'turn-1',
        { push: () => {} },
      )(args, {
        toolCallId,
        abortSignal: new AbortController().signal,
      });

    await execute('browser_snapshot', {}, 'baseline');
    const earlierRef = execute(
      'browser_click',
      { target: { kind: 'ref', value: '[1]' } },
      'earlier-ref',
    );
    await clickPersistenceStarted;
    const laterNavigate = execute(
      'browser_navigate',
      { url: 'https://example.com/next' },
      'later-navigate',
    );
    releaseClickPersistence();
    await Promise.all([earlierRef, laterNavigate]);
    assert.deepEqual(dispatches, [
      'snapshot:baseline',
      'click:earlier-ref',
      'navigate:later-navigate',
    ]);
    permissionEngine.endTurn('turn-1');
  });

  it('fences queued old-Turn dispatch before asynchronous local cleanup settles', async () => {
    const dispatches: string[] = [];
    let finishSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      finishSnapshot = resolve;
    });
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let cleanupSettled = false;
    let markQueuedPersisted!: () => void;
    const queuedPersisted = new Promise<void>((resolve) => {
      markQueuedPersisted = resolve;
    });
    const tools = buildBrowserTools({
      backend: backend({
        snapshot: async (_signal, invoked) => {
          dispatches.push(`snapshot:${invoked.toolCallId}`);
          markSnapshotStarted();
          await snapshotGate;
          return {
            url: '',
            elements: [{ text: '[1]<button />', ref: '[1]' }],
            totalElements: 1,
            takeoverReloaded: false,
          };
        },
        click: async (_input, _signal, invoked) => {
          dispatches.push(`click:${invoked.toolCallId}`);
          return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
        },
        releaseTurnState: async () => {
          await cleanupGate;
          cleanupSettled = true;
        },
      }),
    });
    const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const runtime = new ToolRuntime({
      execution: { kind: 'embedded', getCurrentRunId: () => undefined },
      sessionId: 's1',
      header: runtimeHeader(),
      connection: runtimeConnection(),
      modelId: 'model-1',
      appendMessage: async (message) => {
        if (message.type === 'tool_call' && message.id === 'queued-click') {
          markQueuedPersisted();
        }
      },
      permissionEngine,
      newId: nextId(),
      now: () => 1,
      getPermissionPauseTarget: () => null,
    });
    const execute = (name: string, args: unknown, toolCallId: string) =>
      runtime.wrapToolExecute(
        { ...named<unknown>(tools, name), permissionRequired: false },
        'turn-1',
        { push: () => {} },
      )(args, {
        toolCallId,
        abortSignal: new AbortController().signal,
      });

    const activeSnapshot = execute('browser_snapshot', {}, 'active-snapshot');
    await snapshotStarted;
    const queuedClick = execute(
      'browser_click',
      { target: { kind: 'selector', value: '#queued' } },
      'queued-click',
    );
    await queuedPersisted;
    const cleanup = tools.releaseTurnState({ sessionId: 's1', turnId: 'turn-1' });
    finishSnapshot();
    await activeSnapshot;
    await queuedClick;
    assert.deepEqual(dispatches, ['snapshot:active-snapshot']);
    assert.equal(cleanupSettled, false);

    finishCleanup();
    await cleanup;
    permissionEngine.endTurn('turn-1');
  });

  it('releases a stale invocation when acquire resolves after release and a new Turn', async () => {
    let resolveOldAcquire!: (result: BrowserBackendInvocationAcquisition) => void;
    const oldAcquire = new Promise<BrowserBackendInvocationAcquisition>((resolve) => {
      resolveOldAcquire = resolve;
    });
    let markOldAcquireStarted!: () => void;
    const oldAcquireStarted = new Promise<void>((resolve) => {
      markOldAcquireStarted = resolve;
    });
    const dispatches: string[] = [];
    const invocationReleases: string[] = [];
    const invocation = (label: string, affinity: string): BrowserBackendInvocationAcquisition => ({
      ok: true,
      invocation: {
        affinity,
        backend: backendOperations({
          snapshot: async () => {
            dispatches.push(`${label}:snapshot`);
            return {
              url: '',
              elements: [{ text: '[1]<button />', ref: '[1]' }],
              totalElements: 1,
              takeoverReloaded: false,
            };
          },
          click: async () => {
            dispatches.push(`${label}:click`);
            return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
          },
        }),
        release: () => {
          invocationReleases.push(label);
        },
      },
    });
    const tools = buildBrowserTools({
      invocationProvider: {
        acquire: async ({ context: invoked }) => {
          if (invoked.operationId === 'old-acquire') {
            markOldAcquireStarted();
            return oldAcquire;
          }
          return invocation('new-turn', 'B');
        },
      },
    });

    const stale = run(
      tools,
      'browser_click',
      { target: { kind: 'selector', value: '#old' } },
      'old-acquire',
      'turn-1',
    );
    stale.catch(() => {});
    await oldAcquireStarted;
    const cleanup = tools.releaseTurnState({ sessionId: 's1', turnId: 'turn-1' });
    const fresh = run(tools, 'browser_snapshot', {}, 'new-acquire', 'turn-2');
    resolveOldAcquire(invocation('old-turn', 'A'));
    await assert.rejects(stale, /Turn state ended before backend dispatch/);
    await fresh;
    assert.deepEqual(dispatches, ['new-turn:snapshot']);
    assert.deepEqual([...invocationReleases].sort(), ['new-turn', 'old-turn']);

    await cleanup;
  });

  it('keeps provider affinity and snapshot refs Turn-scoped through loss and cleanup', async () => {
    const acquisitions: Array<{
      operationId: string;
      turnId: string;
      affinity?: string;
    }> = [];
    const dispatches: string[] = [];
    const invocationReleases: string[] = [];

    const providerBackend = (affinity: string): BrowserBackendOperations =>
      backendOperations({
        navigate: async ({ url }, _signal, invoked) => {
          dispatches.push(`${invoked.operationId}:navigate:${affinity}`);
          return { url, title: '', takeoverReloaded: false };
        },
        snapshot: async (_signal, invoked) => {
          dispatches.push(`${invoked.operationId}:snapshot:${affinity}`);
          return {
            url: '',
            elements: [{ text: '[1]<button>A</button>', ref: '[1]' }],
            totalElements: 1,
            takeoverReloaded: false,
          };
        },
        click: async (_input, _signal, invoked) => {
          dispatches.push(`${invoked.operationId}:click:${affinity}`);
          return { matches: 1, matchLevel: 'exact', takeoverReloaded: false };
        },
        type: async (_input, _signal, invoked) => {
          dispatches.push(`${invoked.operationId}:type:${affinity}`);
          return { verified: true, actual: 'x', matchLevel: 'exact', takeoverReloaded: false };
        },
        wait: async (_input, _signal, invoked) => {
          dispatches.push(`${invoked.operationId}:wait:${affinity}`);
          return { takeoverReloaded: false };
        },
        extract: async ({ start }, _signal, invoked) => {
          dispatches.push(`${invoked.operationId}:extract:${affinity}`);
          return {
            url: '',
            chunk: 'ok',
            hasMore: false,
            nextStart: start + 2,
            sourceTruncated: false,
            takeoverReloaded: false,
          };
        },
      });

    const tools = buildBrowserTools({
      invocationProvider: {
        acquire: async ({ context: acquired, affinity }) => {
          acquisitions.push({
            operationId: acquired.operationId,
            turnId: acquired.turnId,
            ...(affinity !== undefined ? { affinity } : {}),
          });
          if (acquired.operationId === 't1-lost') {
            return { ok: false, error: 'service_mismatch', message: 'provider A is gone' };
          }
          const selectedAffinity = affinity ?? (acquired.turnId === 'turn-1' ? 'A' : 'B');
          return {
            ok: true,
            invocation: {
              backend: providerBackend(selectedAffinity),
              affinity: selectedAffinity,
              release: () => {
                invocationReleases.push(acquired.operationId);
              },
            },
          };
        },
      },
    });

    await run(tools, 'browser_snapshot', {}, 't1-snapshot', 'turn-1');
    await run(
      tools,
      'browser_type',
      { target: { kind: 'ref', value: '[1]' }, text: 'x' },
      't1-type',
      'turn-1',
    );
    await run(
      tools,
      'browser_click',
      { target: { kind: 'ref', value: '[1]' } },
      't1-click',
      'turn-1',
    );
    await run(tools, 'browser_navigate', { url: 'https://example.com' }, 't1-navigate', 'turn-1');
    await run(tools, 'browser_wait', { selector: '#ready' }, 't1-wait', 'turn-1');
    await run(tools, 'browser_extract', {}, 't1-extract', 'turn-1');
    assert.deepEqual(
      acquisitions.slice(0, 6).map(({ affinity }) => affinity),
      [undefined, 'A', 'A', 'A', 'A', 'A'],
    );

    const beforeLoss = acquisitions.length;
    await assert.rejects(
      run(tools, 'browser_wait', { time: 1 }, 't1-lost', 'turn-1'),
      /provider A is gone/,
    );
    assert.equal(acquisitions.length, beforeLoss + 1, 'service_mismatch must not retry');
    assert.equal(acquisitions.at(-1)?.affinity, 'A');
    await run(
      tools,
      'browser_click',
      { target: { kind: 'selector', value: '#after-loss' } },
      't1-after-loss',
      'turn-1',
    );
    assert.equal(acquisitions.at(-1)?.affinity, 'A');

    await tools.releaseTurnState({ sessionId: 's1', turnId: 'turn-1' });

    const beforeStaleRef = acquisitions.length;
    await assert.rejects(
      run(
        tools,
        'browser_click',
        { target: { kind: 'ref', value: '[1]' } },
        't2-stale-ref',
        'turn-2',
      ),
      /successful browser_snapshot in the same Turn/,
    );
    assert.equal(acquisitions.length, beforeStaleRef, 'stale ref must fail before acquire');
    await run(tools, 'browser_snapshot', {}, 't2-snapshot', 'turn-2');
    assert.equal(acquisitions.at(-1)?.affinity, undefined);
    await run(
      tools,
      'browser_click',
      { target: { kind: 'ref', value: '[1]' } },
      't2-click',
      'turn-2',
    );
    assert.equal(acquisitions.at(-1)?.affinity, 'B');
    assert.ok(dispatches.includes('t2-snapshot:snapshot:B'));
    assert.ok(dispatches.includes('t2-click:click:B'));
    assert.ok(invocationReleases.includes('t1-after-loss'));
  });

  it('serializes concurrent calls and rejects a conflicting returned affinity', async () => {
    let resolveA!: (result: BrowserBackendInvocationAcquisition) => void;
    const pendingA = new Promise<BrowserBackendInvocationAcquisition>((resolve) => {
      resolveA = resolve;
    });
    const requestedAffinities: Array<string | undefined> = [];
    const dispatched: string[] = [];
    const released: string[] = [];
    const invocation = (affinity: string): BrowserBackendInvocationAcquisition => ({
      ok: true,
      invocation: {
        affinity,
        backend: backendOperations({
          snapshot: async () => {
            dispatched.push(affinity);
            return {
              url: '',
              elements: [{ text: '[1]<button />', ref: '[1]' }],
              totalElements: 1,
              takeoverReloaded: false,
            };
          },
        }),
        release: () => {
          released.push(affinity);
        },
      },
    });
    const tools = buildBrowserTools({
      invocationProvider: {
        acquire: async ({ context: acquired, affinity }) => {
          requestedAffinities.push(affinity);
          return acquired.operationId === 'race-a' ? pendingA : invocation('B');
        },
      },
    });

    const first = run(tools, 'browser_snapshot', {}, 'race-a', 'race-turn');
    const second = run(tools, 'browser_snapshot', {}, 'race-b', 'race-turn');
    first.catch(() => {});
    second.catch(() => {});
    for (let index = 0; index < 5 && requestedAffinities.length < 1; index += 1) {
      await Promise.resolve();
    }
    assert.deepEqual(requestedAffinities, [undefined]);
    resolveA(invocation('A'));
    await first;
    for (let index = 0; index < 5 && requestedAffinities.length < 2; index += 1) {
      await Promise.resolve();
    }
    await assert.rejects(second, /affinity changed within the Turn/);
    assert.deepEqual(requestedAffinities, [undefined, 'A']);
    assert.deepEqual(dispatched, ['A']);
    assert.deepEqual(released, ['A', 'B']);
  });
});

function runtimeHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Browser test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function runtimeConnection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'Browser test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}
