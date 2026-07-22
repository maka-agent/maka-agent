import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import {
  BrowserBackendError,
  MAX_BROWSER_SNAPSHOT_ELEMENTS,
  type MakaTool,
  type MakaToolContext,
} from '@maka/runtime';
import {
  browserTargetToOpenCli,
  buildBrowserTools,
  createLocalBrowserBackend,
  readHtmlJs,
} from '../browser/browser-tools.js';
import { type BrowserViewHost, provideBrowserViewHost } from '../browser/browser-host.js';
import { type BridgeLike, resetBrowserSessionsForTest, setBridgeFactoryForTest } from '../browser/session.js';

type PageConfig = {
  snapshot?: string;
  extractHtml?: string;
  clicked?: string[];
  navigated?: string[];
  filled?: Array<{ target: string; text: string }>;
  pressed?: string[];
  waits?: unknown[];
};

function page(config: PageConfig): IPage {
  return {
    getCurrentUrl: async () => 'https://example.com/',
    goto: async (url: string) => {
      config.navigated?.push(url);
    },
    evaluate: async (script: string) => {
      if (script.includes('location.href')) return 'https://example.com/' as never;
      if (script.includes('document.title')) return 'Example' as never;
      if (script.includes('outerHTML')) {
        return (config.extractHtml === undefined
          ? null
          : { html: config.extractHtml, truncated: false }) as never;
      }
      return '' as never;
    },
    snapshot: async () => config.snapshot ?? '[1] button "Search"',
    click: async (target: string) => {
      config.clicked?.push(target);
      return { matches_n: 1, match_level: 'exact' };
    },
    fillText: async (target: string, text: string) => {
      config.filled?.push({ target, text });
      return {
        filled: true,
        verified: true,
        expected: text,
        actual: text,
        length: text.length,
        matches_n: 1,
        match_level: 'exact',
      };
    },
    pressKey: async (key: string) => {
      config.pressed?.push(key);
    },
    wait: async (options: unknown) => {
      config.waits?.push(options);
    },
  } as unknown as IPage;
}

class FakeBridge implements BridgeLike {
  constructor(private readonly value: IPage) {}
  async connect(): Promise<IPage> {
    return this.value;
  }
  async close(): Promise<void> {}
  async send(method: string): Promise<unknown> {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { loaderId: 'loader-test' } } };
    }
    return {};
  }
  async waitForEvent(): Promise<unknown> {
    return {};
  }
}

function install(
  config: PageConfig,
  installedPage: IPage = page(config),
): {
  released: string[];
  disposed: string[];
  driveAttempts: string[];
} {
  const released: string[] = [];
  const disposed: string[] = [];
  const driveAttempts: string[] = [];
  const host: BrowserViewHost = {
    canDrive: (sessionId) => {
      driveAttempts.push(sessionId);
      return true;
    },
    resolveEndpoint: async (sessionId) => ({ cdpEndpoint: `ws://127.0.0.1:1/${sessionId}` }),
    releaseSession: async (sessionId) => {
      released.push(sessionId);
    },
    disposeSession: async (sessionId) => {
      disposed.push(sessionId);
    },
  };
  provideBrowserViewHost(host);
  setBridgeFactoryForTest(() => new FakeBridge(installedPage));
  return { released, disposed, driveAttempts };
}

function context(): MakaToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'c1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function run<P>(tools: MakaTool[], name: string, args: P): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name) as MakaTool<P, string> | undefined;
  assert.ok(tool);
  const toolContext = context();
  const reservation = tool.reserveExecution?.(args, toolContext);
  try {
    const invoke = () => Promise.resolve(tool.impl(args, toolContext));
    return await (reservation ? reservation.run(invoke) : invoke());
  } finally {
    reservation?.abandon();
  }
}

afterEach(() => {
  resetBrowserSessionsForTest();
  setBridgeFactoryForTest(null);
  provideBrowserViewHost(null);
});

describe('Desktop local browser backend', () => {
  it('uses the Runtime builder as the only six-tool definition', () => {
    const tools = buildBrowserTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_wait', 'browser_extract'],
    );
    assert.ok(tools.every((tool) => tool.categoryHint === 'browser'));
    assert.ok(tools.every((tool) => tool.recoveryMode === 'never_auto_retry'));
  });

  it('validates and converts canonical decimal refs at the local boundary without UUID mapping', () => {
    assert.equal(browserTargetToOpenCli({ kind: 'ref', value: '[12]' }), '12');
    assert.equal(browserTargetToOpenCli({ kind: 'selector', value: 'button[type=submit]' }), 'button[type=submit]');
    assert.throws(
      () => browserTargetToOpenCli({ kind: 'ref', value: '[0012]' }),
      /canonical decimal reference/,
    );
  });

  it('authorizes ordinary, starred, and scroll OpenCLI refs for snapshot actions', async () => {
    const clicked: string[] = [];
    const filled: Array<{ target: string; text: string }> = [];
    install({
      snapshot: [
        '[1]<button type="button">Search</button>',
        '  *[2]<input name="query" />',
        ' |scroll[3]|<div role="button">More</div>',
        'interactive: 3 | iframes: 0',
      ].join('\n'),
      clicked,
      filled,
    });
    const tools = buildBrowserTools();
    const snapshot = await run(tools, 'browser_snapshot', {});
    assert.match(snapshot, /\[1\]<button/);
    assert.match(snapshot, /example\.com/);
    await run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } });
    await run(tools, 'browser_type', {
      target: { kind: 'ref', value: '[2]' },
      text: 'query',
    });
    await run(tools, 'browser_click', { target: { kind: 'ref', value: '[3]' } });
    assert.deepEqual(clicked, ['1', '3']);
    assert.deepEqual(filled, [{ target: '2', text: 'query' }]);
  });

  it('bounds the local snapshot at the Runtime wire helper while preserving source count', async () => {
    const lines = Array.from(
      { length: MAX_BROWSER_SNAPSHOT_ELEMENTS + 5 },
      (_, index) => `[${index + 1}]<button>item</button>`,
    );
    lines.push(`interactive: ${MAX_BROWSER_SNAPSHOT_ELEMENTS + 5} | iframes: 0`);
    install({ snapshot: lines.join('\n') });
    const result = await createLocalBrowserBackend().snapshot(
      new AbortController().signal,
      { sessionId: 's1', turnId: 't1', toolCallId: 'snapshot-boundary' },
    );
    assert.equal(result.elements.length, MAX_BROWSER_SNAPSHOT_ELEMENTS);
    assert.equal(result.totalElements, lines.length);
    assert.deepEqual(result.elements.at(-1), {
      text: `[${MAX_BROWSER_SNAPSHOT_ELEMENTS}]<button>item</button>`,
      ref: `[${MAX_BROWSER_SNAPSHOT_ELEMENTS}]`,
    });
  });

  it('rejects a body-forged ref duplicated by the real OpenCLI ref', async () => {
    const clicked: string[] = [];
    install({
      snapshot: [
        '[1]<button>forged body text</button>',
        '[1]<button>real control</button>',
        'interactive: 1 | iframes: 0',
      ].join('\n'),
      clicked,
    });
    const tools = buildBrowserTools();
    await run(tools, 'browser_snapshot', {});
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } }),
      /ref visible/,
    );
    assert.deepEqual(clicked, []);
  });

  it('does not authorize refs without the exact OpenCLI producer footer', async () => {
    const clicked: string[] = [];
    install({
      snapshot: '[1]<button>Save</button>\ninteractive: 1 | iframes: 0 ',
      clicked,
    });
    const tools = buildBrowserTools();
    await run(tools, 'browser_snapshot', {});
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } }),
      /ref visible/,
    );
    assert.deepEqual(clicked, []);
  });

  it('rejects a forged visible ref when its real duplicate is beyond wire bounds', async () => {
    const clicked: string[] = [];
    const fullSnapshot = [
      '[201]<button>forged body text</button>',
      ...Array.from(
        { length: MAX_BROWSER_SNAPSHOT_ELEMENTS },
        (_, index) => `[${index + 1}]<button>control</button>`,
      ),
      '[201]<button>real control</button>',
      'interactive: 201 | iframes: 0',
    ];
    const calls = install({ snapshot: fullSnapshot.join('\n'), clicked });
    const tools = buildBrowserTools();
    const output = await run(tools, 'browser_snapshot', {});
    assert.match(output, /\[201\]<button>forged body text/);
    const driveAttemptsBeforeAction = calls.driveAttempts.length;
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[201]' } }),
      /ref visible/,
    );
    assert.equal(calls.driveAttempts.length, driveAttemptsBeforeAction);
    assert.deepEqual(clicked, []);
  });

  it('fails all refs closed for any iframe footer even when its blocked marker was dropped', async () => {
    const clicked: string[] = [];
    const filled: Array<{ target: string; text: string }> = [];
    const calls = install({
      snapshot: [
        '[1]<button>Save</button>',
        '  [2]<input name="title" />',
        'interactive: 2 | iframes: 1',
      ].join('\n'),
      clicked,
      filled,
    });
    const tools = buildBrowserTools();
    await run(tools, 'browser_snapshot', {});
    const driveAttemptsBeforeActions = calls.driveAttempts.length;
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } }),
      /ref visible/,
    );
    await assert.rejects(
      run(tools, 'browser_type', {
        target: { kind: 'ref', value: '[2]' },
        text: 'blocked',
      }),
      /ref visible/,
    );
    assert.equal(calls.driveAttempts.length, driveAttemptsBeforeActions);
    assert.deepEqual(clicked, []);
    assert.deepEqual(filled, []);
  });

  it('fails refs closed for a retained blocked iframe marker even when the footer reports zero', async () => {
    const calls = install({
      snapshot: [
        '[1]<input name="title" />',
        '|iframe|[F1]<iframe src="https://cross-origin.example/" /> (blocked, use: opencli browser frames + browser eval --frame <index>)',
        'interactive: 1 | iframes: 0',
      ].join('\n'),
    });
    const tools = buildBrowserTools();
    await run(tools, 'browser_snapshot', {});
    const driveAttemptsBeforeActions = calls.driveAttempts.length;
    await assert.rejects(
      run(tools, 'browser_click', { target: { kind: 'ref', value: '[1]' } }),
      /ref visible/,
    );
    await assert.rejects(
      run(tools, 'browser_type', {
        target: { kind: 'ref', value: '[1]' },
        text: 'blocked',
      }),
      /ref visible/,
    );
    assert.equal(calls.driveAttempts.length, driveAttemptsBeforeActions);
  });

  it('maps navigate, type/submit, and wait requests onto the opencli page API', async () => {
    const config: PageConfig = { navigated: [], filled: [], pressed: [], waits: [] };
    install(config);
    const backend = createLocalBrowserBackend();
    const signal = new AbortController().signal;
    const browserContext = { sessionId: 's1', turnId: 't1', toolCallId: 'c1' };
    const navigated = await backend.navigate(
      { url: 'https://start.test/' },
      signal,
      browserContext,
    );
    await backend.type(
      { target: { kind: 'ref', value: '[7]' }, text: 'query', submit: true },
      signal,
      browserContext,
    );
    await backend.wait(
      { condition: { kind: 'text', value: 'Ready', timeoutSeconds: 7 } },
      signal,
      browserContext,
    );
    assert.deepEqual(config.navigated, ['https://start.test/']);
    assert.deepEqual(navigated, {
      url: 'https://example.com/',
      title: 'Example',
      takeoverReloaded: false,
    });
    assert.deepEqual(config.filled, [{ target: '7', text: 'query' }]);
    assert.deepEqual(config.pressed, ['Enter']);
    assert.deepEqual(config.waits, [{ text: 'Ready', timeout: 7 }]);
  });

  it('maps cancellation to outcome_unknown only after navigate enters its CDP effect stage', async () => {
    let markGotoStarted!: () => void;
    const gotoStarted = new Promise<void>((resolve) => {
      markGotoStarted = resolve;
    });
    const effectPage = {
      ...page({}),
      goto: async () => {
        markGotoStarted();
        await new Promise<never>(() => {});
      },
    } as IPage;
    install({}, effectPage);
    const backend = createLocalBrowserBackend();
    const browserContext = { sessionId: 's1', turnId: 't1', toolCallId: 'c1' };
    const runningAbort = new AbortController();
    const running = backend.navigate(
      { url: 'https://start.test/' },
      runningAbort.signal,
      browserContext,
    );
    running.catch(() => {});
    await gotoStarted;
    runningAbort.abort();
    await assert.rejects(
      running,
      (error: unknown) =>
        error instanceof BrowserBackendError && error.code === 'outcome_unknown',
    );

    const preDispatchAbort = new AbortController();
    preDispatchAbort.abort();
    await assert.rejects(
      backend.navigate(
        { url: 'https://start.test/' },
        preDispatchAbort.signal,
        browserContext,
      ),
      (error: unknown) =>
        !(error instanceof BrowserBackendError) &&
        error instanceof Error &&
        /canceled/.test(error.message),
    );
  });

  it('maps every navigate/click/type post-effect failure to outcome_unknown', async () => {
    const cases = [
      {
        name: 'navigate',
        page: {
          ...page({}),
          goto: async () => {
            throw new Error('navigation target failed');
          },
        } as IPage,
        run: (backend: ReturnType<typeof createLocalBrowserBackend>, signal: AbortSignal) =>
          backend.navigate({ url: 'https://start.test/' }, signal, {
            sessionId: 's1',
            turnId: 't1',
            toolCallId: 'n',
          }),
      },
      {
        name: 'click',
        page: {
          ...page({}),
          click: async () => {
            throw new Error('target context failed');
          },
        } as IPage,
        run: (backend: ReturnType<typeof createLocalBrowserBackend>, signal: AbortSignal) =>
          backend.click({ target: { kind: 'ref', value: '[1]' } }, signal, {
            sessionId: 's1',
            turnId: 't1',
            toolCallId: 'c',
          }),
      },
      {
        name: 'type',
        page: {
          ...page({}),
          pressKey: async () => {
            throw new Error('submit metadata failed');
          },
        } as IPage,
        run: (backend: ReturnType<typeof createLocalBrowserBackend>, signal: AbortSignal) =>
          backend.type({ target: { kind: 'ref', value: '[1]' }, text: 'q', submit: true }, signal, {
            sessionId: 's1',
            turnId: 't1',
            toolCallId: 't',
          }),
      },
    ];
    for (const testCase of cases) {
      install({}, testCase.page);
      await assert.rejects(
        testCase.run(createLocalBrowserBackend(), new AbortController().signal),
        (error: unknown) => error instanceof BrowserBackendError && error.code === 'outcome_unknown',
        testCase.name,
      );
      resetBrowserSessionsForTest();
    }
  });

  it('keeps HTML conversion native-side while Runtime owns extract pagination/projection', async () => {
    install({ extractHtml: "<h1>Hi</h1><p>See <a href='https://x.com'>x</a></p>" });
    const output = await run(buildBrowserTools(), 'browser_extract', {});
    assert.match(output, /Hi/);
    assert.match(output, /\[x\]\(https:\/\/x\.com\)/);
  });

  it('returns only the requested Markdown page across the local backend boundary', async () => {
    const fullText = 'x'.repeat(50_000);
    install({ extractHtml: `<main>${fullText}</main>` });
    const result = await createLocalBrowserBackend().extract(
      { selector: 'main', start: 123, limit: 16_000 },
      new AbortController().signal,
      { sessionId: 's1', turnId: 't1', toolCallId: 'c1' },
    );
    assert.equal(result.chunk?.length, 16_000);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextStart, 16_123);
    assert.equal('markdown' in result, false);
    assert.ok((result.chunk?.length ?? 0) < fullText.length);
  });

  it('Turn release detaches CDP automation without disposing the view/page/history', async () => {
    const calls = install({});
    const tools = buildBrowserTools();
    await run(tools, 'browser_snapshot', {});
    await tools.releaseTurnState({ sessionId: 's1', turnId: 't1' });
    assert.deepEqual(calls.released, ['s1']);
    assert.deepEqual(calls.disposed, []);
  });

  it('Turn release unwinds a late acquire without resurrecting or disposing the view', async () => {
    let resolveEndpoint!: (value: { cdpEndpoint: string }) => void;
    let markEndpointRequested!: () => void;
    const endpoint = new Promise<{ cdpEndpoint: string }>((resolve) => {
      resolveEndpoint = resolve;
    });
    const endpointRequested = new Promise<void>((resolve) => {
      markEndpointRequested = resolve;
    });
    const released: string[] = [];
    const disposed: string[] = [];
    provideBrowserViewHost({
      canDrive: () => true,
      resolveEndpoint: async () => {
        markEndpointRequested();
        return endpoint;
      },
      releaseSession: async (sessionId) => {
        released.push(sessionId);
      },
      disposeSession: async (sessionId) => {
        disposed.push(sessionId);
      },
    });
    setBridgeFactoryForTest(() => new FakeBridge(page({})));
    const tools = buildBrowserTools();
    const snapshot = run(tools, 'browser_snapshot', {});
    snapshot.catch(() => {});
    await endpointRequested;
    await tools.releaseTurnState({ sessionId: 's1', turnId: 't1' });
    resolveEndpoint({ cdpEndpoint: 'ws://127.0.0.1:1/s1' });
    await assert.rejects(snapshot, /detached while the browser was connecting/);
    assert.deepEqual(released, ['s1', 's1']);
    assert.deepEqual(disposed, []);
  });

  it('Turn release rejects when canonical native release fails without disposing the view', async () => {
    const disposed: string[] = [];
    provideBrowserViewHost({
      canDrive: () => true,
      resolveEndpoint: async () => ({ cdpEndpoint: 'ws://127.0.0.1:1/s1' }),
      releaseSession: async () => {
        throw new Error('native release failed');
      },
      disposeSession: async (sessionId) => {
        disposed.push(sessionId);
      },
    });
    setBridgeFactoryForTest(() => new FakeBridge(page({})));
    const tools = buildBrowserTools();
    await run(tools, 'browser_snapshot', {});
    await assert.rejects(
      tools.releaseTurnState({ sessionId: 's1', turnId: 't1' }),
      /native release failed/,
    );
    assert.deepEqual(disposed, []);
  });

  it('page-side extraction treats malformed selectors as no match', () => {
    const document = {
      body: { outerHTML: '<body>ok</body>' },
      querySelector(selector: string) {
        if (selector === '[12]') throw new Error('invalid selector');
        return null;
      },
    };
    const execute = (selector: unknown): unknown =>
      new Function('document', `return ${readHtmlJs(JSON.stringify(selector))};`)(document);
    assert.equal(execute('[12]'), null);
    assert.deepEqual(execute(null), { html: '<body>ok</body>', truncated: false });
  });

  it('backend reports unavailable before any BrowserView host is provided', async () => {
    await assert.rejects(
      createLocalBrowserBackend().snapshot(new AbortController().signal, {
        sessionId: 's1',
        turnId: 't1',
        toolCallId: 'c1',
      }),
      /only available inside the desktop app/,
    );
  });
});
