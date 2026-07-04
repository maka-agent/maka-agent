import { strict as assert } from 'node:assert';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core';
import { build, type Plugin } from 'esbuild';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const LUCIDE_REACT_PACKAGE = ['lucide', 'react'].join('-');

type SessionHistoryModule = {
  SessionHistoryList(props: {
    sessions: SessionSummary[];
    activeId?: string;
    streamingSessionIds?: Set<string>;
    staleSessionIds?: Set<string>;
    onSelectSession(sessionId: string): void;
  }): ReactElement | null;
};
type RendererWindow = Window & typeof globalThis;
type RenderProbeGlobal = typeof globalThis & {
  __makaSessionRowRenderProbe?: (sessionId: string) => void;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  while (cleanupTasks.length > 0) {
    cleanupTasks.pop()?.();
  }
});

describe('UI render memo boundary contract', () => {
  it('keeps sidebar session rows from rendering on unrelated parent updates', async () => {
    const { SessionHistoryList } = await importInstrumentedSessionHistoryList();
    const root = installReactRenderer();
    const rowRenderCount = new Map<string, number>();
    const sessions = [
      createSession('session-a', 'Alpha'),
      createSession('session-b', 'Beta'),
    ];
    const streamingSessionIds = new Set<string>();
    const staleSessionIds = new Set<string>();
    const onSelectSession = () => {};
    (globalThis as RenderProbeGlobal).__makaSessionRowRenderProbe = (sessionId) => {
      rowRenderCount.set(sessionId, (rowRenderCount.get(sessionId) ?? 0) + 1);
    };

    await render(root, createElement(RenderHost, {
      SessionHistoryList,
      label: 'first parent render',
      onSelectSession,
      sessions,
      staleSessionIds,
      streamingSessionIds,
    }));
    assert.deepEqual(Object.fromEntries(rowRenderCount), {
      'session-a': 1,
      'session-b': 1,
    });

    await render(root, createElement(RenderHost, {
      SessionHistoryList,
      label: 'unrelated parent render',
      onSelectSession,
      sessions,
      staleSessionIds,
      streamingSessionIds,
    }));

    assert.deepEqual(
      Object.fromEntries(rowRenderCount),
      {
        'session-a': 1,
        'session-b': 1,
      },
      'stable session row props should not re-render when only sibling parent content changes',
    );
  });
});

function RenderHost(props: {
  SessionHistoryList: SessionHistoryModule['SessionHistoryList'];
  label: string;
  onSelectSession(sessionId: string): void;
  sessions: SessionSummary[];
  staleSessionIds: Set<string>;
  streamingSessionIds: Set<string>;
}) {
  return createElement(
    'div',
    null,
    createElement('p', null, props.label),
    createElement(props.SessionHistoryList, {
      sessions: props.sessions,
      activeId: 'session-a',
      streamingSessionIds: props.streamingSessionIds,
      staleSessionIds: props.staleSessionIds,
      onSelectSession: props.onSelectSession,
    }),
  );
}

function createSession(id: string, name: string): SessionSummary {
  return {
    id,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: 1_700_000_000_000,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  };
}

async function importInstrumentedSessionHistoryList(): Promise<SessionHistoryModule> {
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/session-history-memo-'));
  const outfile = resolve(outdir, 'session-history-list.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'packages/ui/src/session-history-list.tsx')],
    outfile,
    bundle: true,
    external: ['@base-ui/react', LUCIDE_REACT_PACKAGE, 'react', 'react-dom', 'react-dom/*', 'react/jsx-runtime'],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [instrumentSessionRow(), mockOverlayScrollbars()],
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as SessionHistoryModule;
}

function instrumentSessionRow(): Plugin {
  return {
    name: 'instrument-session-row',
    setup(buildApi) {
      buildApi.onLoad({ filter: /packages\/ui\/src\/session-history-list\.tsx$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const target = /(function SessionRow\(props: \{[\s\S]*?\n\}\) \{\n)/;
        assert.match(source, target, 'test instrumentation must find the private SessionRow render boundary');
        return {
          loader: 'tsx',
          contents: source.replace(
            target,
            `$1  (globalThis as typeof globalThis & { __makaSessionRowRenderProbe?: (sessionId: string) => void }).__makaSessionRowRenderProbe?.(props.session.id);\n`,
          ),
        };
      });
    },
  };
}

function mockOverlayScrollbars(): Plugin {
  return {
    name: 'mock-overlayscrollbars',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^overlayscrollbars$/ }, () => ({
        path: 'overlayscrollbars-mock',
        namespace: 'memo-test',
      }));
      buildApi.onLoad({ filter: /^overlayscrollbars-mock$/, namespace: 'memo-test' }, () => ({
        loader: 'js',
        contents: 'export function OverlayScrollbars() { return { destroy() {}, options() {} }; }',
      }));
    },
  };
}

function installReactRenderer(): Root {
  installFakeDom();
  const container = new FakeElement('div', document);
  const root = createRoot(container as unknown as Element);
  cleanupTasks.push(() => {
    act(() => {
      root.unmount();
    });
  });
  return root;
}

async function render(root: Root, element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function installFakeDom(): void {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLIFrameElement = globalThis.HTMLIFrameElement;
  const previousProbe = (globalThis as RenderProbeGlobal).__makaSessionRowRenderProbe;
  const previousActEnvironment = (globalThis as RenderProbeGlobal).IS_REACT_ACT_ENVIRONMENT;
  const fakeDocument = createFakeDocument();
  const fakeWindow = {
    document: fakeDocument,
    addEventListener: () => {},
    removeEventListener: () => {},
    HTMLElement: FakeElement,
    HTMLIFrameElement: class HTMLIFrameElement {},
  } as unknown as RendererWindow;
  Object.defineProperty(fakeDocument, 'defaultView', { value: fakeWindow });
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
  globalThis.HTMLIFrameElement = fakeWindow.HTMLIFrameElement;
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
  (globalThis as RenderProbeGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  cleanupTasks.push(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLIFrameElement = previousHTMLIFrameElement;
    (globalThis as RenderProbeGlobal).__makaSessionRowRenderProbe = previousProbe;
    (globalThis as RenderProbeGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
}

function createFakeDocument(): Document {
  const fakeDocument = {
    nodeType: 9,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement(tagName: string) {
      return new FakeElement(tagName, fakeDocument as unknown as Document);
    },
    createElementNS(_namespace: string, tagName: string) {
      return new FakeElement(tagName, fakeDocument as unknown as Document);
    },
    createTextNode(text: string) {
      return new FakeText(text, fakeDocument as unknown as Document);
    },
  };
  Object.defineProperty(fakeDocument, 'documentElement', {
    value: new FakeElement('html', fakeDocument as unknown as Document),
  });
  return fakeDocument as unknown as Document;
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly nodeName: string;
  readonly nodeType = 1;
  readonly tagName: string;
  parentNode: FakeElement | null = null;
  textContent = '';

  constructor(tagName: string, readonly ownerDocument: Document) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  addEventListener(): void {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(node: T): T {
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  insertBefore<T extends FakeElement | FakeText>(node: T, before: FakeElement | FakeText | null): T {
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) return this.appendChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  removeChild<T extends FakeElement | FakeText>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    node.parentNode = null;
    return node;
  }

  removeEventListener(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeText {
  readonly nodeName = '#text';
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;

  constructor(readonly nodeValue: string, readonly ownerDocument: Document) {}
}
