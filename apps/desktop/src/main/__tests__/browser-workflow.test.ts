import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import {
  BROWSER_WORKFLOW_MAX_ACTIONS,
  type BrowserWorkflow,
  type BrowserWorkflowProgress,
} from '@maka/core/browser-workflow';
import type { BrowserWorkflowStore } from '@maka/storage';
import { createBrowserWorkflowService } from '../browser/browser-workflow-service.js';
import {
  type BrowserRecorderEvent,
  createBrowserWorkflowRecorderInstallScript,
  flushBrowserWorkflowNavigation,
  notifyBrowserWorkflowNavigation,
  notifyBrowserWorkflowRecorderEvent,
  normalizeBrowserRecorderEvent,
  parseBrowserWorkflowRecorderConsoleMessage,
  setBrowserWorkflowNavigationRecorder,
  WORKFLOW_RECORDER_EVENT_PREFIX,
} from '../browser/workflow-recorder.js';
import { runBrowserWorkflowAction } from '../browser/workflow-runner.js';
import { getBrowserCopy } from '../../renderer/locales/browser-copy.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class MemoryWorkflowStore implements BrowserWorkflowStore {
  readonly workflows = new Map<string, BrowserWorkflow>();

  async loadAll(): Promise<BrowserWorkflow[]> {
    return [...this.workflows.values()];
  }

  async get(id: string): Promise<BrowserWorkflow | undefined> {
    return this.workflows.get(id);
  }

  async save(workflow: BrowserWorkflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async remove(id: string): Promise<void> {
    this.workflows.delete(id);
  }
}

afterEach(() => {
  setBrowserWorkflowNavigationRecorder(null);
});

describe('browser workflow recorder', () => {
  test('provides locale-specific default workflow names', () => {
    assert.equal(getBrowserCopy('zh').defaultWorkflowName, '操作流程');
    assert.equal(getBrowserCopy('en').defaultWorkflowName, 'Browser workflow');
  });

  test('rejects a page-forged recorder message without the active credential', () => {
    const forged = `${WORKFLOW_RECORDER_EVENT_PREFIX}${JSON.stringify({
      kind: 'type',
      locator: { kind: 'name', value: 'password' },
      value: 'must-not-persist',
      sensitive: false,
      timestamp: 1,
    })}`;

    assert.equal(
      (parseBrowserWorkflowRecorderConsoleMessage as (message: string, credential: string) => unknown | null)(
        forged,
        'active-recorder-credential',
      ),
      null,
    );
  });

  test('accepts a recorder message carrying the active credential', () => {
    const event = {
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    };

    assert.deepEqual(
      parseBrowserWorkflowRecorderConsoleMessage(
        `${WORKFLOW_RECORDER_EVENT_PREFIX}active-recorder-credential:${JSON.stringify(event)}`,
        'active-recorder-credential',
      ),
      event,
    );
  });

  test('rejects recorder events with an unsupported locator kind', () => {
    assert.equal(
      normalizeBrowserRecorderEvent({
        kind: 'click',
        locator: { kind: 'css', value: '#submit' },
        timestamp: 1,
      }),
      null,
    );
  });

  test('rejects temporary snapshot references', () => {
    assert.equal(
      normalizeBrowserRecorderEvent({
        kind: 'click',
        locator: { kind: 'text', value: ' [42] ' },
        timestamp: 1,
      }),
      null,
    );
  });

  test('drops a sensitive input value at the main-process boundary', () => {
    assert.deepEqual(
      normalizeBrowserRecorderEvent({
        kind: 'type',
        locator: { kind: 'name', value: 'password' },
        value: 'must-not-persist',
        sensitive: true,
        timestamp: 1,
      }),
      {
        kind: 'type',
        locator: { kind: 'name', value: 'password' },
        sensitive: true,
        submit: false,
        timestamp: 1,
      },
    );
  });

  test('marks a single-line form input as submitted when Enter triggers submission', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'text',
      value: 'Alice',
      id: '',
      form: {},
      closest: () => input,
      getAttribute: (name: string) => (name === 'data-testid' ? 'name' : null),
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });
    listeners.get('keydown')?.({
      target: input,
      key: 'Enter',
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.equal(recorder.drain().at(-1)?.submit, true);
  });

  test('redacts standard payment autocomplete fields inside the page recorder', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'text',
      value: '4111111111111111',
      id: '',
      closest: () => input,
      getAttribute: (name: string) => {
        if (name === 'data-testid') return 'card-number';
        if (name === 'autocomplete') return 'cc-number';
        return null;
      },
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    const event = recorder.drain().at(-1);
    assert.equal(event?.sensitive, true);
    assert.equal(event?.value, undefined);
  });

  test('redacts sensitive values identified by placeholder, test id, or associated label', () => {
    const cases = [
      { placeholder: 'Enter your API key' },
      { testId: 'auth-token-input' },
      { labelText: 'Client secret' },
    ];

    for (const metadata of cases) {
      const listeners = new Map<string, (event: Record<string, unknown>) => void>();
      const input = {
        tagName: 'INPUT',
        type: 'text',
        value: 'must-not-persist',
        id: '',
        labels: metadata.labelText
          ? [{ innerText: metadata.labelText, textContent: metadata.labelText }]
          : [],
        closest: () => input,
        getAttribute: (name: string) => {
          if (name === 'data-testid') return metadata.testId ?? null;
          if (name === 'placeholder') return metadata.placeholder ?? null;
          if (name === 'name') return 'value';
          return null;
        },
      };
      const document = {
        addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
          listeners.set(type, listener),
        removeEventListener: () => {},
        querySelectorAll: (selector: string) =>
          selector === '[name]' || (selector === '[data-testid]' && metadata.testId) ? [input] : [],
      };
      const window = {} as Record<string, unknown>;
      new Function(
        'window',
        'document',
        `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`,
      )(window, document);

      listeners.get('input')?.({ target: input });

      const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
      const event = recorder.drain().at(-1);
      assert.equal(event?.sensitive, true, JSON.stringify(metadata));
      assert.equal(event?.value, undefined, JSON.stringify(metadata));
    }
  });

  test('does not use a sensitive value as fallback locator evidence', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'password',
      value: 'fallback-secret',
      id: '',
      innerText: '',
      closest: () => input,
      getAttribute: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === 'input' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain(), []);
    assert.doesNotMatch(JSON.stringify(recorder), /fallback-secret/);
  });

  test('does not use a mutable text input value as fallback locator evidence', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'text',
      value: 'Alice',
      id: '',
      innerText: '',
      closest: () => input,
      getAttribute: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === 'input' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain(), []);
  });

  test('does not record file input interactions', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const input = {
      tagName: 'INPUT',
      type: 'file',
      value: 'C:\\fakepath\\document.pdf',
      id: 'attachment',
      closest: () => input,
      getAttribute: (name: string) => (name === 'data-testid' ? 'attachment' : null),
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [input] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('click')?.({ target: input });
    listeners.get('input')?.({ target: input });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain(), []);
  });

  test('records contenteditable text from its visible content', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const editor = {
      tagName: 'DIV',
      innerText: 'Draft body',
      textContent: 'Draft body',
      id: '',
      closest: () => editor,
      getAttribute: (name: string) => {
        if (name === 'data-testid') return 'editor';
        if (name === 'role') return 'textbox';
        if (name === 'contenteditable') return 'true';
        return null;
      },
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [editor] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: editor });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.equal(recorder.drain().at(-1)?.value, 'Draft body');
  });

  test('records text-labeled button clicks without stable attributes', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const button = {
      tagName: 'BUTTON',
      innerText: 'Submit',
      textContent: 'Submit',
      id: '',
      closest: () => button,
      getAttribute: () => null,
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === 'button' ? [button] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('click')?.({ target: button });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.deepEqual(recorder.drain().at(-1)?.locator, {
      kind: 'role',
      value: 'Submit',
      tag: 'button',
      role: 'button',
    });
  });

  test('preserves values from custom textbox elements', () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const control = {
      tagName: 'MY-INPUT',
      value: 'Alice',
      innerText: '',
      textContent: '',
      id: '',
      closest: () => control,
      getAttribute: (name: string) => {
        if (name === 'data-testid') return 'custom-name';
        if (name === 'role') return 'textbox';
        return null;
      },
    };
    const document = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => {},
      querySelectorAll: (selector: string) => (selector === '[data-testid]' ? [control] : []),
    };
    const window = {} as Record<string, unknown>;
    new Function('window', 'document', `return ${createBrowserWorkflowRecorderInstallScript('test-credential')};`)(
      window,
      document,
    );

    listeners.get('input')?.({ target: control });

    const recorder = window.__makaBrowserWorkflowRecorderV1 as { drain(): BrowserRecorderEvent[] };
    assert.equal(recorder.drain().at(-1)?.value, 'Alice');
  });
});

describe('browser workflow runner', () => {
  test('waits for an interaction-driven URL without navigating again', async () => {
    let currentUrl = 'https://example.test/form';
    let reads = 0;
    const page = {
      goto: async () => assert.fail('URL waits must not issue a second navigation'),
      getCurrentUrl: async () => 'https://example.test/form',
      evaluate: async () => {
        reads += 1;
        return currentUrl;
      },
      wait: async () => {
        currentUrl = 'https://example.test/submitted';
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'wait-navigation',
        kind: 'wait',
        url: 'https://example.test/submitted',
        timeoutMs: 1_000,
      },
      {},
    );

    assert.equal(reads, 2);
  });

  test('fails deterministically when a stable locator no longer matches', async () => {
    const page = {
      evaluate: async () => ({ ok: false, reason: 'not_found', matched: 0 }),
    } as unknown as IPage;

    await assert.rejects(
      runBrowserWorkflowAction(
        page,
        { id: 'click-submit', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
        {},
      ),
      /did not match an element.*Re-record this workflow/,
    );
  });

  test('replays clicks through the page native-input path', async () => {
    const evaluated: string[] = [];
    let clickedSelector = '';
    const page = {
      evaluate: async (script: string) => {
        evaluated.push(script);
        return { ok: true, matched: 1 };
      },
      click: async (selector: string) => {
        clickedSelector = selector;
        return { matches_n: 1, match_level: 'exact' as const };
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      { id: 'click-submit', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      {},
    );

    assert.match(clickedSelector, /^\[data-maka-browser-workflow-target="[^"]+"\]$/);
    assert.equal(evaluated.some((script) => script.includes('element.click()')), false);
  });

  test('replays a text-labeled button locator', async () => {
    const attributes = new Map<string, string>();
    const button = {
      tagName: 'BUTTON',
      innerText: 'Submit',
      textContent: 'Submit',
      value: '',
      isContentEditable: false,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      click: () => assert.fail('replay should use the native page click path'),
    };
    const document = {
      querySelectorAll: (selector: string) => {
        if (selector === 'button') return [button];
        if (selector.startsWith('[')) return attributes.size > 0 ? [button] : [];
        return [];
      },
      getElementById: () => null,
    };
    let clickedSelector = '';
    const page = {
      evaluate: async (script: string) => new Function('document', `return ${script};`)(document),
      click: async (selector: string) => {
        clickedSelector = selector;
        assert.equal(attributes.size, 1);
      },
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'click-submit',
        kind: 'click',
        locator: { kind: 'role', value: 'Submit', tag: 'button', role: 'button' },
      },
      {},
    );

    assert.match(clickedSelector, /^\[data-maka-browser-workflow-target="[^"]+"\]$/);
    assert.equal(attributes.size, 0);
  });

  test('requires a sensitive value only at replay time', async () => {
    let evaluated = false;
    const page = {
      evaluate: async () => {
        evaluated = true;
        return { ok: true, matched: 1 };
      },
    } as unknown as IPage;

    await assert.rejects(
      runBrowserWorkflowAction(
        page,
        {
          id: 'type-password',
          kind: 'type',
          locator: { kind: 'name', value: 'password' },
          sensitive: true,
          submit: false,
        },
        {},
      ),
      /Sensitive value required for workflow action type-password/,
    );
    assert.equal(evaluated, false);
  });

  test('types into a textarea through its native value setter', async () => {
    class FakeInput {
      set value(_next: string) {
        if (!(this instanceof FakeInput)) throw new TypeError('Illegal invocation');
      }
    }
    class FakeTextarea {
      value = '';
      getAttribute(name: string) {
        return name === 'name' ? 'notes' : null;
      }
      focus() {}
      dispatchEvent() {}
    }
    class FakeEvent {}
    const textarea = new FakeTextarea();
    const document = {
      querySelectorAll: (selector: string) => (selector === '[name]' ? [textarea] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          FakeInput,
          FakeTextarea,
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-notes',
        kind: 'type',
        locator: { kind: 'name', value: 'notes' },
        value: 'remember this',
        sensitive: false,
        submit: false,
      },
      {},
    );
    assert.equal(textarea.value, 'remember this');
  });

  test('replays locators for native inputs with implicit textbox roles', async () => {
    class FakeInput {
      tagName = 'INPUT';
      type = 'text';
      value = 'before';
      innerText = '';
      focus() {}
      dispatchEvent() {}
      getAttribute() {
        return null;
      }
    }
    class FakeEvent {}
    const input = new FakeInput();
    const document = {
      querySelectorAll: (selector: string) => (selector === 'input' ? [input] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          FakeInput,
          class FakeTextarea {},
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-native-input',
        kind: 'type',
        locator: { kind: 'role', value: 'before', tag: 'input', role: 'textbox' },
        value: 'after',
        sensitive: false,
        submit: false,
      },
      {},
    );
    assert.equal(input.value, 'after');
  });

  test('replays value-backed custom textboxes', async () => {
    class FakeCustomTextbox {
      tagName = 'MY-INPUT';
      value = 'before';
      innerText = '';
      textContent = '';
      focus() {}
      dispatchEvent() {}
      getAttribute(name: string) {
        return name === 'role' ? 'textbox' : null;
      }
    }
    class FakeEvent {}
    const control = new FakeCustomTextbox();
    const document = {
      querySelectorAll: (selector: string) => (selector === 'my-input' ? [control] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          class FakeInput {},
          class FakeTextarea {},
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-custom',
        kind: 'type',
        locator: { kind: 'role', value: 'before', tag: 'my-input', role: 'textbox' },
        value: 'after',
        sensitive: false,
        submit: false,
      },
      {},
    );

    assert.equal(control.value, 'after');
  });

  test('types into a contenteditable textbox through its text content', async () => {
    class FakeContentEditable {
      textContent = 'before';
      tagName = 'DIV';
      get innerText() {
        return this.textContent;
      }
      get isContentEditable() {
        return true;
      }
      focus() {}
      dispatchEvent() {}
      getAttribute(name: string) {
        return name === 'role' ? 'textbox' : null;
      }
    }
    class FakeEvent {}
    const editor = new FakeContentEditable();
    const document = {
      querySelectorAll: (selector: string) => (selector === 'div' ? [editor] : []),
      getElementById: () => null,
    };
    const page = {
      evaluate: async (script: string) =>
        new Function('document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return ${script};`)(
          document,
          class FakeInput {},
          class FakeTextarea {},
          FakeEvent,
        ),
    } as unknown as IPage;

    await runBrowserWorkflowAction(
      page,
      {
        id: 'type-editor',
        kind: 'type',
        locator: { kind: 'role', value: 'before', tag: 'div', role: 'textbox' },
        value: 'after',
        sensitive: false,
        submit: false,
      },
      {},
    );
    assert.equal(editor.textContent, 'after');
  });
});

describe('browser workflow service', () => {
  test('rejects missing sensitive values before acquiring the browser page', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-sensitive', {
      schemaVersion: 1,
      id: 'workflow-sensitive',
      name: 'Sensitive workflow',
      createdAt: 1,
      updatedAt: 1,
      actions: [
        { id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' },
        {
          id: 'secret-1',
          kind: 'type',
          locator: { kind: 'name', value: 'password' },
          sensitive: true,
          submit: false,
        },
      ],
    });
    let boundaryCalls = 0;
    const progress: BrowserWorkflowProgress[] = [];
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    await assert.rejects(service.run('workflow-sensitive', 'session-1'), /Sensitive value required.*secret-1/);
    assert.equal(boundaryCalls, 0);
    assert.deepEqual(progress, []);
  });

  test('rejects replay while the target browser page is being recorded', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    let boundaryCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    await service.startRecording('session-1');
    try {
      await assert.rejects(service.run('workflow-1', 'session-1'), /recording is active/i);
      assert.equal(boundaryCalls, 0);
    } finally {
      await service.cancelRecording('session-1');
    }
  });

  test('rejects recording while the target browser page is replaying a workflow', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    let recorderStarts = 0;
    const view = {
      startWorkflowRecorder: async () => {
        recorderStarts += 1;
      },
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryStarted.resolve();
        await boundaryRelease.promise;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    try {
      await assert.rejects(service.startRecording('session-1'), /workflow is running/i);
      assert.equal(recorderStarts, 0);
    } finally {
      await service.cancelRecording('session-1');
      boundaryRelease.resolve();
      await running;
    }
  });

  test('rejects replay while recorder startup is still in flight', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const recorderStarting = deferred<void>();
    const recorderRelease = deferred<void>();
    let boundaryCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {
        recorderStarting.resolve();
        await recorderRelease.promise;
      },
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    const starting = service.startRecording('session-1');
    await recorderStarting.promise;
    try {
      await assert.rejects(service.run('workflow-1', 'session-1'), /recording is active/i);
      assert.equal(boundaryCalls, 0);
    } finally {
      recorderRelease.resolve();
      await starting;
      await service.cancelRecording('session-1');
    }
  });

  test('rejects replay when recording wins during workflow lookup', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const workflowRequested = deferred<void>();
    const workflowRelease = deferred<void>();
    store.get = async (id: string) => {
      workflowRequested.resolve();
      await workflowRelease.promise;
      return store.workflows.get(id);
    };
    let boundaryCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await workflowRequested.promise;
    await service.startRecording('session-1');
    workflowRelease.resolve();
    try {
      await assert.rejects(running, /recording is active/i);
      assert.equal(boundaryCalls, 0);
    } finally {
      await service.cancelRecording('session-1');
    }
  });

  test('stops recording actions at the workflow contract limit', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return Array.from({ length: BROWSER_WORKFLOW_MAX_ACTIONS + 1 }, (_, index) => ({
          kind: 'click' as const,
          locator: { kind: 'test_id' as const, value: `button-${index}` },
          timestamp: index,
        }));
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-limit');
    const draft = await service.stopRecording('session-limit');
    assert.equal(draft.actions.length, BROWSER_WORKFLOW_MAX_ACTIONS);
    const workflow = await service.saveRecording(draft.draftId, 'Bounded workflow');
    assert.equal(workflow.actions.length, BROWSER_WORKFLOW_MAX_ACTIONS);
  });

  test('preserves Enter submission while coalescing type events for one input', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'test_id', value: 'name' },
            value: 'Alice',
            sensitive: false,
            submit: false,
            timestamp: 100,
          },
          {
            kind: 'type',
            locator: { kind: 'test_id', value: 'name' },
            value: 'Alice',
            sensitive: false,
            submit: true,
            timestamp: 101,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Submit with Enter');

    const typeAction = workflow.actions.find((action) => action.kind === 'type');
    assert.equal(typeAction?.kind === 'type' && typeAction.submit, true);
  });

  test('serializes recorder startup and cancellation for the same session', async () => {
    const firstStart = deferred<void>();
    const secondStop = deferred<void>();
    let starts = 0;
    let stops = 0;
    const view = {
      startWorkflowRecorder: async () => {
        starts += 1;
        if (starts === 1) await firstStart.promise;
      },
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => {
        stops += 1;
        if (stops === 2) await secondStop.promise;
        return [];
      },
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    const starting = service.startRecording('session-1');
    const canceling = service.cancelRecording('session-1');
    firstStart.resolve();
    await Promise.all([starting, canceling]);

    assert.equal(stops, 1);
    await service.startRecording('session-1');
    assert.equal(starts, 2);
    const cancelingForRestart = service.cancelRecording('session-1');
    const restarting = service.startRecording('session-1');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(starts, 2);
    secondStop.resolve();
    await Promise.all([cancelingForRestart, restarting]);
    assert.equal(starts, 3);
    await service.cancelRecording('session-1');
  });

  test('waits for an in-flight recorder drain before creating the draft', async () => {
    const firstDrain = deferred<unknown[]>();
    const firstDrainStarted = deferred<void>();
    let drainCalls = 0;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        drainCalls += 1;
        if (drainCalls === 1) {
          firstDrainStarted.resolve();
          return firstDrain.promise;
        }
        return [];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    await firstDrainStarted.promise;
    const stopping = service.stopRecording('session-1');
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const stoppedBeforeDrain = stopped;
    firstDrain.resolve([
      {
        kind: 'click',
        locator: { kind: 'test_id', value: 'continue' },
        timestamp: 2,
      },
    ]);

    assert.equal(stoppedBeforeDrain, false);
    assert.equal((await stopping).actionCount, 2);
  });

  test('deduplicates successive input events for the same locator', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          { kind: 'type', locator: { kind: 'name', value: 'username' }, value: 'a', timestamp: 1 },
          { kind: 'type', locator: { kind: 'name', value: 'username' }, value: 'alice', timestamp: 2 },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Sign in');

    assert.deepEqual(workflow.actions.slice(1), [
      {
        id: workflow.actions[1]?.id,
        kind: 'type',
        locator: { kind: 'name', value: 'username' },
        value: 'alice',
        sensitive: false,
        submit: false,
      },
    ]);
  });

  test('never stores a sensitive value in a saved workflow', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'name', value: 'password' },
            value: 'must-not-persist',
            sensitive: true,
            timestamp: 1,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Sign in');

    assert.doesNotMatch(JSON.stringify(workflow), /must-not-persist/);
    assert.equal(workflow.actions[1]?.kind, 'type');
    if (workflow.actions[1]?.kind === 'type') assert.equal(workflow.actions[1].value, undefined);
  });

  test('never downgrades a deduplicated sensitive input action', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'name', value: 'secret' },
            value: 'first-secret',
            sensitive: true,
            timestamp: 1,
          },
          {
            kind: 'type',
            locator: { kind: 'name', value: 'secret' },
            value: 'second-secret',
            sensitive: false,
            timestamp: 2,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Secret');

    assert.equal(workflow.actions[1]?.kind, 'type');
    if (workflow.actions[1]?.kind === 'type') {
      assert.equal(workflow.actions[1].sensitive, true);
      assert.equal(workflow.actions[1].value, undefined);
    }
  });

  test('records each distinct main-frame navigation once', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    notifyBrowserWorkflowNavigation('session-1', 'https://example.test/next');
    notifyBrowserWorkflowNavigation('session-1', 'https://example.test/next');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Navigate');

    assert.deepEqual(
      workflow.actions.map((action) => (action.kind === 'navigate' ? action.url : action.kind)),
      ['https://example.test/start', 'https://example.test/next'],
    );
  });

  test('records interaction-driven navigation as an expected URL wait', async () => {
    const store = new MemoryWorkflowStore();
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            eventId: 'click-submit',
            kind: 'click',
            locator: { kind: 'test_id', value: 'submit' },
            timestamp: 1,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    notifyBrowserWorkflowRecorderEvent('session-1', {
      eventId: 'click-submit',
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    });
    await flushBrowserWorkflowNavigation('session-1');
    notifyBrowserWorkflowNavigation('session-1', 'https://example.test/submitted');
    const draft = await service.stopRecording('session-1');

    assert.deepEqual(
      draft.actions.map((action) =>
        action.kind === 'navigate'
          ? action.url
          : action.kind === 'wait' && 'url' in action
            ? action.url
            : action.kind,
      ),
      ['https://example.test/form', 'click', 'https://example.test/submitted'],
    );
    assert.equal(draft.actions.at(-1)?.kind, 'wait');
  });

  test('records toolbar navigation as an explicit navigation action', async () => {
    const store = new MemoryWorkflowStore();
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/form' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
    });

    await service.startRecording('session-1');
    notifyBrowserWorkflowRecorderEvent('session-1', {
      eventId: 'click-submit',
      kind: 'click',
      locator: { kind: 'test_id', value: 'submit' },
      timestamp: 1,
    });
    await notifyBrowserWorkflowNavigation('session-1', 'https://example.test/previous', 'explicit');
    const draft = await service.stopRecording('session-1');
    const workflow = await service.saveRecording(draft.draftId, 'Toolbar navigation');

    assert.deepEqual(
      workflow.actions.map((action) => (action.kind === 'navigate' ? action.url : action.kind)),
      ['https://example.test/form', 'click', 'https://example.test/previous'],
    );
  });

  test('records an observed wait condition in order and exposes the safe draft for review', async () => {
    const store = new MemoryWorkflowStore();
    const page = {
      evaluate: async (script: string) => {
        assert.match(script, /data-testid/);
        return { ok: true, matched: 1 };
      },
    } as unknown as IPage;
    let drained = false;
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => {
        if (drained) return [];
        drained = true;
        return [
          {
            kind: 'type',
            locator: { kind: 'name', value: 'password' },
            value: 'must-not-cross-ipc',
            sensitive: true,
            timestamp: 1,
          },
        ];
      },
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: <T>(
        _sessionId: string,
        _label: string,
        run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>,
      ) => run(page, { takeoverReloaded: false }),
    });

    await service.startRecording('session-1');
    await service.addWaitCondition('session-1', {
      kind: 'selector',
      value: '[data-testid="ready"]',
      timeoutMs: 10_000,
    });
    const draft = await service.stopRecording('session-1');

    assert.deepEqual(
      draft.actions.map((action) => action.kind),
      ['navigate', 'type', 'wait'],
    );
    assert.doesNotMatch(JSON.stringify(draft.actions), /must-not-cross-ipc/);
    assert.deepEqual(draft.actions.at(-1), {
      id: draft.actions.at(-1)?.id,
      kind: 'wait',
      selector: '[data-testid="ready"]',
      timeoutMs: 10_000,
    });
  });

  test('rejects wait conditions that are not observable on the recorded page', async () => {
    const view = {
      startWorkflowRecorder: async () => {},
      drainWorkflowRecorderEvents: async () => [],
      stopWorkflowRecorder: async () => [],
      state: () => ({ url: 'https://example.test/start' }),
    };
    const service = createBrowserWorkflowService({
      store: new MemoryWorkflowStore(),
      views: { getOrCreate: () => view } as never,
      sendToRenderer: () => {},
      runWithPage: async <T>(
        _sessionId: string,
        _label: string,
        run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>,
      ) =>
        run(
          { evaluate: async () => ({ ok: false, reason: 'not_found', matched: 0 }) } as unknown as IPage,
          { takeoverReloaded: false },
        ),
    });

    await service.startRecording('session-1');
    await assert.rejects(
      service.addWaitCondition('session-1', {
        kind: 'text',
        value: 'Ready to continue',
        timeoutMs: 10_000,
      }),
      /not currently observable/i,
    );
    await service.cancelRecording('session-1');
  });

  test('reports cancellation when the page boundary settles after abort', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    const progress: BrowserWorkflowProgress[] = [];
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: async <T>() => {
        boundaryStarted.resolve();
        await boundaryRelease.promise;
        return undefined as T;
      },
    });

    const running = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    const runId = progress.find((event) => event.status === 'running')?.runId;
    assert.ok(runId);
    service.cancel(runId);
    boundaryRelease.resolve();

    await assert.rejects(running, /canceled/i);
    assert.equal(progress.at(-1)?.status, 'canceled');
  });

  test('keeps the run slot until a canceled page boundary settles', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Navigate',
      createdAt: 1,
      updatedAt: 1,
      actions: [{ id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' }],
    });
    const boundaryStarted = deferred<void>();
    const boundaryRelease = deferred<void>();
    const progress: BrowserWorkflowProgress[] = [];
    let boundaryCalls = 0;
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: async <T>() => {
        boundaryCalls += 1;
        if (boundaryCalls === 1) {
          boundaryStarted.resolve();
          await boundaryRelease.promise;
        }
        return undefined as T;
      },
    });

    const firstRun = service.run('workflow-1', 'session-1');
    await boundaryStarted.promise;
    const runId = progress.find((event) => event.status === 'running')?.runId;
    assert.ok(runId);
    service.cancel(runId);
    let secondError: unknown;
    try {
      await service.run('workflow-1', 'session-1');
    } catch (error) {
      secondError = error;
    }
    boundaryRelease.resolve();
    await assert.rejects(firstRun, /canceled/i);

    assert.match(secondError instanceof Error ? secondError.message : '', /Another browser workflow is already running/);
    assert.equal(boundaryCalls, 1);
  });

  test('emits ordered progress for each replayed action', async () => {
    const store = new MemoryWorkflowStore();
    store.workflows.set('workflow-1', {
      schemaVersion: 1,
      id: 'workflow-1',
      name: 'Submit',
      createdAt: 1,
      updatedAt: 1,
      actions: [
        { id: 'navigate-1', kind: 'navigate', url: 'https://example.test/' },
        { id: 'click-1', kind: 'click', locator: { kind: 'test_id', value: 'submit' } },
      ],
    });
    const page = {
      goto: async () => {},
      evaluate: async () => ({ ok: true, matched: 1 }),
      click: async () => ({ matches_n: 1, match_level: 'exact' as const }),
    } as unknown as IPage;
    const progress: BrowserWorkflowProgress[] = [];
    const service = createBrowserWorkflowService({
      store,
      views: { getOrCreate: () => ({}) } as never,
      sendToRenderer: (_channel, event) => progress.push(event),
      runWithPage: <T>(_sessionId: string, _label: string, run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>) =>
        run(page, { takeoverReloaded: false }),
    });

    await service.run('workflow-1', 'session-1');

    assert.deepEqual(
      progress.map((event) => [event.status, event.current, event.total]),
      [
        ['running', 0, 2],
        ['running', 1, 2],
        ['running', 2, 2],
        ['completed', 2, 2],
      ],
    );
  });
});
