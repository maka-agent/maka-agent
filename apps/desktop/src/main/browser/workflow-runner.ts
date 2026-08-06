import { randomUUID } from 'node:crypto';
import type {
  BrowserWorkflowAction,
  BrowserWorkflowLocator,
  BrowserWorkflowWaitConditionInput,
} from '@maka/core/browser-workflow';
import { isBrowserWorkflowWaitConditionInput } from '@maka/core/browser-workflow';
import type { IPage } from '@jackwener/opencli/types';

type LocatorResult = { ok: true; matched: number; actual?: string } | { ok: false; reason: string };
type WaitConditionResult = { ok: true; matched: number } | { ok: false; reason: string; matched: number };
const WORKFLOW_CLICK_MARKER_ATTRIBUTE = 'data-maka-browser-workflow-target';

export async function assertBrowserWorkflowWaitCondition(
  page: IPage,
  input: BrowserWorkflowWaitConditionInput,
): Promise<void> {
  if (!isBrowserWorkflowWaitConditionInput(input)) throw new Error('Invalid browser workflow wait condition.');
  const encoded = JSON.stringify(input);
  const result = await page.evaluate<WaitConditionResult>(`(() => {
    const input = ${encoded};
    if (input.kind === 'selector') {
      try {
        const matched = document.querySelectorAll(input.value).length;
        return matched > 0 ? { ok: true, matched } : { ok: false, reason: 'not_found', matched };
      } catch {
        return { ok: false, reason: 'invalid_selector', matched: 0 };
      }
    }
    const bodyText = document.body?.innerText ?? '';
    return bodyText.includes(input.value)
      ? { ok: true, matched: 1 }
      : { ok: false, reason: 'not_found', matched: 0 };
  })()`);
  if (!result.ok) {
    const reason = result.reason === 'invalid_selector' ? 'invalid CSS selector' : 'not currently observable';
    throw new Error(`Browser workflow wait condition is ${reason}. Observe it on the page before recording.`);
  }
}

function resolveLocatorScript(
  locator: BrowserWorkflowLocator,
  operation: 'click' | 'type',
  value?: string,
  clickMarker?: { attribute: string; value: string },
): string {
  const encoded = JSON.stringify(locator);
  const encodedValue = JSON.stringify(value ?? '');
  const clickEffect = clickMarker
    ? `element.setAttribute(${JSON.stringify(clickMarker.attribute)}, ${JSON.stringify(clickMarker.value)});`
    : 'element.click();';
  return `(() => {
    const locator = ${encoded};
    const value = ${encodedValue};
    const clean = (input) => String(input || '').replace(/\\s+/g, ' ').trim();
    const all = (selector) => Array.from(document.querySelectorAll(selector));
    const roleFor = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = String(el.type || '').toLowerCase();
        return ['checkbox', 'radio', 'submit', 'button'].includes(type) ? type : 'textbox';
      }
      const contenteditable = el.getAttribute('contenteditable');
      if (el.isContentEditable === true || (contenteditable !== null && contenteditable.toLowerCase() !== 'false')) return 'textbox';
      return undefined;
    };
    const isContentEditableElement = (el) => {
      const contenteditable = el.getAttribute('contenteditable');
      return el.isContentEditable === true || (contenteditable !== null && contenteditable.toLowerCase() !== 'false');
    };
    const inputValue = (el) => {
      if (isContentEditableElement(el)) return String(el.innerText ?? el.textContent ?? '');
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return String(el.value || '');
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      if (
        tag === 'button' ||
        tag === 'a' ||
        ['button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'submit', 'switch', 'tab'].includes(role)
      ) {
        return String(el.innerText ?? el.textContent ?? '');
      }
      if ('value' in el && el.value !== undefined && el.value !== null) return String(el.value || '');
      return String(el.innerText ?? el.textContent ?? '');
    };
    const candidates = (() => {
      switch (locator.kind) {
        case 'test_id': return all('[data-testid]') .filter((el) => el.getAttribute('data-testid') === locator.value);
        case 'aria_label': return all('[aria-label]') .filter((el) => el.getAttribute('aria-label') === locator.value);
        case 'name': return all('[name]') .filter((el) => el.getAttribute('name') === locator.value);
        case 'id': { const el = document.getElementById(locator.value); return el ? [el] : []; }
        case 'role': return all(locator.tag || '*').filter((el) =>
          roleFor(el) === locator.role && clean(inputValue(el)) === locator.value,
        );
        case 'text': return all(locator.tag || '*').filter((el) => clean(inputValue(el)) === locator.value);
        default: return [];
      }
    })();
    if (candidates.length !== 1) return { ok: false, reason: candidates.length === 0 ? 'not_found' : 'ambiguous', matched: candidates.length };
    const element = candidates[0];
    if (${JSON.stringify(operation)} === 'click') {
      ${clickEffect}
      return { ok: true, matched: 1 };
    }
    if (isContentEditableElement(element)) {
      element.textContent = value;
    } else {
      const setter = element instanceof HTMLTextAreaElement
        ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        : element instanceof HTMLInputElement
          ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          : undefined;
      if (setter) setter.call(element, value);
      else element.value = value;
    }
    element.focus();
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, matched: 1, actual: inputValue(element) };
  })()`;
}

function clearClickMarkerScript(marker: { attribute: string; value: string }): string {
  const attribute = JSON.stringify(marker.attribute);
  const value = JSON.stringify(marker.value);
  return `(() => {
    for (const element of document.querySelectorAll('[' + ${attribute} + ']')) {
      if (element.getAttribute(${attribute}) === ${value}) element.removeAttribute(${attribute});
    }
  })()`;
}

export async function runBrowserWorkflowAction(
  page: IPage,
  action: BrowserWorkflowAction,
  sensitiveValues: Record<string, string>,
): Promise<void> {
  switch (action.kind) {
    case 'navigate':
      await page.goto(action.url, { waitUntil: 'load' });
      return;
    case 'click': {
      const marker = { attribute: WORKFLOW_CLICK_MARKER_ATTRIBUTE, value: randomUUID() };
      const result = await page.evaluate<LocatorResult>(
        resolveLocatorScript(action.locator, 'click', undefined, marker),
      );
      assertLocatorResult(result, action.locator);
      const selector = `[${marker.attribute}=${JSON.stringify(marker.value)}]`;
      try {
        // IPage.click uses the browser's native CDP input path when available,
        // preserving trusted user activation for replayed interactions.
        await page.click(selector);
      } finally {
        await page.evaluate(clearClickMarkerScript(marker)).catch(() => {});
      }
      return;
    }
    case 'type': {
      const value = action.sensitive ? sensitiveValues[action.id] : action.value;
      if (typeof value !== 'string') throw new Error(`Sensitive value required for workflow action ${action.id}.`);
      const result = await page.evaluate<LocatorResult>(resolveLocatorScript(action.locator, 'type', value));
      assertLocatorResult(result, action.locator);
      if (action.submit) await page.pressKey('Enter');
      return;
    }
    case 'wait':
      if (action.url) await waitForWorkflowUrl(page, action.url, action.timeoutMs);
      else if (action.selector)
        await page.wait({ selector: action.selector, timeout: action.timeoutMs / 1000 });
      else if (action.text) await page.wait({ text: action.text, timeout: action.timeoutMs / 1000 });
      return;
  }
}

async function waitForWorkflowUrl(page: IPage, expectedUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let currentUrl = '';
  while (true) {
    try {
      const evaluated = await page.evaluate<string>('window.location.href');
      currentUrl = typeof evaluated === 'string' ? evaluated : '';
    } catch {
      currentUrl = page.getCurrentUrl ? await page.getCurrentUrl().catch(() => '') : '';
    }
    if (currentUrl === expectedUrl) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Browser workflow navigation did not reach ${expectedUrl}; current URL is ${currentUrl || 'unknown'}.`,
      );
    }
    await page.wait({ time: Math.min(100, remainingMs) / 1000 });
  }
}

function assertLocatorResult(result: LocatorResult, locator: BrowserWorkflowLocator): void {
  if (result.ok) return;
  const detail = result.reason === 'ambiguous' ? 'matched multiple elements' : 'did not match an element';
  throw new Error(`Workflow locator ${JSON.stringify(locator)} ${detail}. Re-record this workflow.`);
}
