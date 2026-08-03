import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BROWSER_WORKFLOW_REDACTED_VALUE,
  isBrowserWorkflow,
  isSensitiveBrowserInput,
  validateBrowserWorkflow,
} from '../browser-workflow.js';

const workflow = {
  schemaVersion: 1 as const,
  id: 'workflow-1',
  name: 'Sign in',
  createdAt: 1,
  updatedAt: 2,
  actions: [
    { id: 'a1', kind: 'navigate' as const, url: 'https://example.test/' },
    { id: 'a2', kind: 'click' as const, locator: { kind: 'test_id' as const, value: 'submit' } },
    {
      id: 'a3',
      kind: 'type' as const,
      locator: { kind: 'name' as const, value: 'password' },
      sensitive: true,
      submit: true,
    },
  ],
};

describe('browser workflow contract', () => {
  test('accepts stable actions and validates the complete workflow', () => {
    assert.equal(isBrowserWorkflow(workflow), true);
    assert.deepEqual(validateBrowserWorkflow(workflow), workflow);
  });

  test('rejects snapshot refs and invalid sensitive payloads', () => {
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'click', kind: 'click', locator: { kind: 'text', value: '[12]' } }],
      }),
      false,
      'temporary snapshot refs are never accepted as workflow locators',
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'type',
            kind: 'type',
            locator: { kind: 'name', value: 'password' },
            sensitive: true,
            value: 'raw-secret',
            submit: false,
          },
        ],
      }),
      false,
    );
    assert.throws(() => validateBrowserWorkflow({ ...workflow, actions: [] }));
    assert.equal(BROWSER_WORKFLOW_REDACTED_VALUE, '__MAKA_REDACTED__');
  });

  test('requires one bounded observable condition for wait actions', () => {
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'wait', kind: 'wait', selector: '  ', timeoutMs: 10_000 }],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [{ id: 'wait', kind: 'wait', text: '', timeoutMs: 10_000 }],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'wait',
            kind: 'wait',
            selector: '[data-testid="ready"]',
            text: 'Ready',
            timeoutMs: 10_000,
          },
        ],
      }),
      false,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          { id: 'wait', kind: 'wait', selector: '[data-testid="ready"]', timeoutMs: 10_000 },
        ],
      }),
      true,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          { id: 'wait', kind: 'wait', url: 'https://example.test/complete', timeoutMs: 10_000 },
        ],
      }),
      true,
    );
    assert.equal(
      isBrowserWorkflow({
        ...workflow,
        actions: [
          {
            id: 'wait',
            kind: 'wait',
            selector: '[data-testid="ready"]',
            url: 'https://example.test/complete',
            timeoutMs: 10_000,
          },
        ],
      }),
      false,
    );
  });

  test('detects sensitive browser fields without inspecting their value', () => {
    const detect = isSensitiveBrowserInput as (input: Record<string, string>) => boolean;
    assert.equal(isSensitiveBrowserInput({ type: 'password' }), true);
    assert.equal(isSensitiveBrowserInput({ autocomplete: 'one-time-code' }), true);
    assert.equal(isSensitiveBrowserInput({ autocomplete: 'cc-number' }), true);
    assert.equal(detect({ placeholder: 'Enter your API key' }), true);
    assert.equal(detect({ testId: 'auth-token-input' }), true);
    assert.equal(detect({ labelText: 'Client secret' }), true);
    assert.equal(isSensitiveBrowserInput({ name: 'email' }), false);
    assert.equal(isSensitiveBrowserInput({ ariaLabel: 'Search' }), false);
  });
});
