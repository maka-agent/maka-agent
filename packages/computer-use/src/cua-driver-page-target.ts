import { execFile } from 'node:child_process';
import type { CuPoint } from '@maka/core';

export interface CuaCdpPageTarget {
  port: number;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CuaFocusedPageElement {
  editable: boolean;
  value: string;
  tagName: string;
  inputType?: string;
}

export interface CuaResolvedPageTextTarget {
  port: number;
  pageTargetId: string;
  pageUrl: string;
  targetUrlContains: string;
}

export type CuaSemanticPointerAction =
  | {
      type: 'left_click' | 'right_click' | 'double_click';
      screenPoint: CuPoint;
    }
  | {
      type: 'left_click_drag';
      startScreenPoint: CuPoint;
      endScreenPoint: CuPoint;
    };

export interface CuaSemanticPointerResult {
  supported: boolean;
  ok: boolean;
  kind?: string;
  effect?: string;
  editable?: boolean;
  tagName?: string;
  inputType?: string;
  clickEvents?: number;
  doubleClickEvents?: number;
  contextMenuEvents?: number;
  inputEvents?: number;
  changeEvents?: number;
  mutations?: number;
  checked?: boolean;
  defaultPrevented?: boolean;
  value?: string;
  reason?: string;
}

export interface CuaPageTargetResolverDeps {
  listListeningPorts?: (pid: number, signal: AbortSignal) => Promise<number[]>;
  fetchTargets?: (port: number, signal: AbortSignal) => Promise<CuaCdpPageTarget[]>;
}

export const CUA_INSPECT_PREPARED_ELEMENT_SCRIPT = `(() => {
  const element = globalThis.__makaComputerUseTarget;
  if (!element) return JSON.stringify({ editable: false, value: '', tagName: '' });
  return JSON.stringify(globalThis.__makaComputerUseReadElement(element));
})()`;

const TEXT_INPUT_TYPES = ['email', 'number', 'search', 'tel', 'text', 'url'] as const;

export async function resolveCuaPageTextTarget(
  input: {
    pid: number;
    windowTitle?: string;
    signal: AbortSignal;
  },
  deps: CuaPageTargetResolverDeps = {},
): Promise<CuaResolvedPageTextTarget | undefined> {
  const listListeningPorts = deps.listListeningPorts ?? listProcessListeningPorts;
  const fetchTargets = deps.fetchTargets ?? fetchCdpPageTargets;

  const ports = await listListeningPorts(input.pid, input.signal);
  if (ports.length === 0) return undefined;
  const groups = await Promise.all(
    ports.map(async (port) => {
      try {
        return await fetchTargets(port, input.signal);
      } catch {
        return [];
      }
    }),
  );
  const targets = groups.flat();
  if (targets.length === 0) return undefined;

  const title = input.windowTitle?.trim();
  const titleMatches = title ? targets.filter((target) => target.title.trim() === title) : [];
  const target =
    titleMatches.length === 1
      ? titleMatches[0]
      : titleMatches.length === 0 && targets.length === 1
        ? targets[0]
        : undefined;
  if (!target || target.url.length === 0) return undefined;

  const sameUrl = targets.filter(
    (candidate) => candidate.port === target.port && candidate.url === target.url,
  );
  if (sameUrl.length !== 1) return undefined;

  return {
    port: target.port,
    pageTargetId: pageTargetId(target.webSocketDebuggerUrl),
    pageUrl: target.url,
    targetUrlContains: uniqueUrlHint(target, targets),
  };
}

function pageTargetId(webSocketDebuggerUrl: string): string {
  const marker = '/devtools/page/';
  const index = webSocketDebuggerUrl.lastIndexOf(marker);
  return index >= 0 ? webSocketDebuggerUrl.slice(index + marker.length) : webSocketDebuggerUrl;
}

function uniqueUrlHint(target: CuaCdpPageTarget, targets: readonly CuaCdpPageTarget[]): string {
  try {
    const hash = new URL(target.url).hash;
    if (hash && targets.filter((candidate) => candidate.url.includes(hash)).length === 1) {
      return hash;
    }
  } catch {
    // Non-standard URLs fall back to the exact string.
  }
  return target.url;
}

export function buildCuaPrepareElementAtScreenPointScript(screenPoint: CuPoint): string {
  return `(() => {
    const textInputTypes = new Set(${JSON.stringify(TEXT_INPUT_TYPES)});
    globalThis.__makaComputerUseReadElement = (element) => {
      const tagName = String(element?.tagName || '').toLowerCase();
      const inputType = tagName === 'input' ? String(element.type || 'text').toLowerCase() : '';
      const editable = !element?.disabled
        && !element?.readOnly
        && element?.getAttribute?.('aria-disabled') !== 'true'
        && (
          tagName === 'textarea'
          || (tagName === 'input' && textInputTypes.has(inputType))
          || element?.isContentEditable === true
        );
      const value = tagName === 'input' || tagName === 'textarea'
        ? String(element.value || '')
        : element?.isContentEditable === true
          ? String(element.textContent || '')
          : '';
      return { editable, value, tagName, inputType };
    };
    const chromeLeft = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - chromeLeft);
    const viewportX = ${JSON.stringify(screenPoint.x)} - window.screenX - chromeLeft;
    const viewportY = ${JSON.stringify(screenPoint.y)} - window.screenY - chromeTop;
    let element = document.elementFromPoint(viewportX, viewportY);
    while (element && !globalThis.__makaComputerUseReadElement(element).editable) {
      element = element.parentElement;
    }
    if (!element) {
      globalThis.__makaComputerUseTarget = undefined;
      return JSON.stringify({ editable: false, value: '', tagName: '' });
    }
    globalThis.__makaComputerUseTarget = element;
    return JSON.stringify(globalThis.__makaComputerUseReadElement(element));
  })()`;
}

export function buildCuaSemanticPointerActionScript(action: CuaSemanticPointerAction): string {
  const start = action.type === 'left_click_drag' ? action.startScreenPoint : action.screenPoint;
  const end = action.type === 'left_click_drag' ? action.endScreenPoint : action.screenPoint;
  return `(async () => {
    const actionType = ${JSON.stringify(action.type)};
    const textInputTypes = new Set(${JSON.stringify(TEXT_INPUT_TYPES)});
    const chromeLeft = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - chromeLeft);
    const viewportPoint = (screenX, screenY) => ({
      x: screenX - window.screenX - chromeLeft,
      y: screenY - window.screenY - chromeTop
    });
    const start = viewportPoint(${JSON.stringify(start.x)}, ${JSON.stringify(start.y)});
    const end = viewportPoint(${JSON.stringify(end.x)}, ${JSON.stringify(end.y)});
    const element = document.elementFromPoint(start.x, start.y);
    if (!element) return JSON.stringify({ supported: false, ok: false, reason: 'no_element' });
    const tagName = String(element.tagName || '').toLowerCase();
    const inputType = tagName === 'input' ? String(element.type || 'text').toLowerCase() : '';
    const editable = !element.disabled
      && !element.readOnly
      && element.getAttribute?.('aria-disabled') !== 'true'
      && (
        tagName === 'textarea'
        || (tagName === 'input' && textInputTypes.has(inputType))
        || element.isContentEditable === true
      );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const observeMutations = () => {
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      return { observer, read: () => mutations };
    };
    if (actionType === 'left_click') {
      let clickEvents = 0;
      const onClick = () => { clickEvents += 1; };
      const beforeChecked = typeof element.checked === 'boolean' ? element.checked : undefined;
      const beforeValue = 'value' in element ? String(element.value ?? '') : undefined;
      const mutation = observeMutations();
      element.addEventListener('click', onClick, true);
      element.focus?.({ preventScroll: true });
      element.click();
      await settle();
      element.removeEventListener('click', onClick, true);
      mutation.observer.disconnect();
      const mutations = mutation.read();
      const checkedChanged = beforeChecked !== undefined && element.checked !== beforeChecked;
      const valueChanged = beforeValue !== undefined && String(element.value ?? '') !== beforeValue;
      const focusedEditable = editable && document.activeElement === element;
      const ok = focusedEditable || checkedChanged || valueChanged || mutations > 0;
      return JSON.stringify({
        supported: true,
        ok,
        kind: actionType,
        effect: focusedEditable
          ? 'focus'
          : checkedChanged
            ? 'checked'
            : valueChanged
              ? 'value'
              : mutations > 0
                ? 'mutation'
                : undefined,
        editable,
        tagName,
        inputType,
        clickEvents,
        mutations,
        ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
        ...(!ok ? { reason: 'no_observable_effect' } : {})
      });
    }
    if (actionType === 'double_click') {
      let clickEvents = 0;
      let doubleClickEvents = 0;
      const onClick = () => { clickEvents += 1; };
      const onDoubleClick = () => { doubleClickEvents += 1; };
      const mutation = observeMutations();
      element.addEventListener('click', onClick, true);
      element.addEventListener('dblclick', onDoubleClick, true);
      element.focus?.({ preventScroll: true });
      element.click();
      element.click();
      element.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: 2,
        button: 0
      }));
      await settle();
      element.removeEventListener('click', onClick, true);
      element.removeEventListener('dblclick', onDoubleClick, true);
      mutation.observer.disconnect();
      const mutations = mutation.read();
      const ok = mutations > 0;
      return JSON.stringify({
        supported: true,
        ok,
        kind: actionType,
        effect: ok ? 'mutation' : undefined,
        editable,
        tagName,
        inputType,
        clickEvents,
        doubleClickEvents,
        mutations,
        ...(!ok ? { reason: 'no_observable_effect' } : {})
      });
    }
    if (actionType === 'right_click') {
      let contextMenuEvents = 0;
      const onContextMenu = () => { contextMenuEvents += 1; };
      const mutation = observeMutations();
      element.addEventListener('contextmenu', onContextMenu, true);
      for (const [type, buttons] of [['mousedown', 2], ['mouseup', 0]]) {
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          buttons,
          clientX: start.x,
          clientY: start.y
        }));
      }
      const contextMenu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 0,
        clientX: start.x,
        clientY: start.y
      });
      const accepted = element.dispatchEvent(contextMenu);
      await settle();
      element.removeEventListener('contextmenu', onContextMenu, true);
      mutation.observer.disconnect();
      const mutations = mutation.read();
      const defaultPrevented = contextMenu.defaultPrevented || !accepted;
      const ok = defaultPrevented || mutations > 0;
      return JSON.stringify({
        supported: true,
        ok,
        kind: actionType,
        effect: defaultPrevented ? 'contextmenu_consumed' : mutations > 0 ? 'mutation' : undefined,
        editable,
        tagName,
        inputType,
        contextMenuEvents,
        mutations,
        defaultPrevented,
        ...(!ok ? { reason: 'no_observable_effect' } : {})
      });
    }
    if (actionType === 'left_click_drag') {
      if (tagName !== 'input' || String(element.type || '').toLowerCase() !== 'range') {
        return JSON.stringify({ supported: false, ok: false, reason: 'not_range', tagName });
      }
      const endElement = document.elementFromPoint(end.x, end.y);
      if (endElement !== element) {
        return JSON.stringify({ supported: false, ok: false, reason: 'range_endpoint_mismatch', tagName });
      }
      const style = getComputedStyle(element);
      if (style.direction !== 'ltr' || !String(style.writingMode || '').startsWith('horizontal')) {
        return JSON.stringify({ supported: false, ok: false, reason: 'unsupported_range_direction', tagName });
      }
      const rect = element.getBoundingClientRect();
      const minimum = Number(element.min || 0);
      const maximum = Number(element.max || 100);
      const stepAttribute = String(element.getAttribute('step') || '1').toLowerCase();
      const step = stepAttribute === 'any' ? undefined : Number(stepAttribute);
      if (
        !Number.isFinite(minimum)
        || !Number.isFinite(maximum)
        || maximum <= minimum
        || (step !== undefined && (!Number.isFinite(step) || step <= 0))
      ) {
        return JSON.stringify({ supported: false, ok: false, reason: 'invalid_range_constraints', tagName });
      }
      const ratio = Math.max(0, Math.min(1, (end.x - rect.left) / Math.max(rect.width, 1)));
      const rawValue = minimum + (maximum - minimum) * ratio;
      const value = step === undefined
        ? rawValue
        : Math.max(minimum, Math.min(maximum, Math.round((rawValue - minimum) / step) * step + minimum));
      let inputEvents = 0;
      let changeEvents = 0;
      const onInput = () => { inputEvents += 1; };
      const onChange = () => { changeEvents += 1; };
      element.addEventListener('input', onInput, true);
      element.addEventListener('change', onChange, true);
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!valueSetter) {
        element.removeEventListener('input', onInput, true);
        element.removeEventListener('change', onChange, true);
        return JSON.stringify({ supported: false, ok: false, reason: 'range_setter_unavailable', tagName });
      }
      valueSetter.call(element, String(value));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      element.removeEventListener('input', onInput, true);
      element.removeEventListener('change', onChange, true);
      const persisted = Math.abs(Number(element.value) - value) <= Math.max(Math.abs(value) * 1e-9, 1e-9);
      return JSON.stringify({
        supported: true,
        ok: persisted,
        kind: 'range_drag',
        effect: persisted ? 'value' : undefined,
        tagName,
        inputType,
        inputEvents,
        changeEvents,
        value: element.value,
        ...(!persisted ? { reason: 'range_value_did_not_persist' } : {})
      });
    }
    return JSON.stringify({ supported: false, ok: false, reason: 'unsupported_action' });
  })()`;
}

export function parseCuaSemanticPointerResult(
  value: string | undefined,
): CuaSemanticPointerResult | undefined {
  if (!value) return undefined;
  try {
    const result = JSON.parse(value) as Record<string, unknown>;
    if (typeof result.supported !== 'boolean' || typeof result.ok !== 'boolean') return undefined;
    return {
      supported: result.supported,
      ok: result.ok,
      ...(typeof result.kind === 'string' ? { kind: result.kind } : {}),
      ...(typeof result.effect === 'string' ? { effect: result.effect } : {}),
      ...(typeof result.editable === 'boolean' ? { editable: result.editable } : {}),
      ...(typeof result.tagName === 'string' ? { tagName: result.tagName } : {}),
      ...(typeof result.inputType === 'string' ? { inputType: result.inputType } : {}),
      ...(typeof result.clickEvents === 'number' ? { clickEvents: result.clickEvents } : {}),
      ...(typeof result.doubleClickEvents === 'number'
        ? { doubleClickEvents: result.doubleClickEvents }
        : {}),
      ...(typeof result.contextMenuEvents === 'number'
        ? { contextMenuEvents: result.contextMenuEvents }
        : {}),
      ...(typeof result.inputEvents === 'number' ? { inputEvents: result.inputEvents } : {}),
      ...(typeof result.changeEvents === 'number' ? { changeEvents: result.changeEvents } : {}),
      ...(typeof result.mutations === 'number' ? { mutations: result.mutations } : {}),
      ...(typeof result.checked === 'boolean' ? { checked: result.checked } : {}),
      ...(typeof result.defaultPrevented === 'boolean'
        ? { defaultPrevented: result.defaultPrevented }
        : {}),
      ...(typeof result.value === 'string' ? { value: result.value } : {}),
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    };
  } catch {
    return undefined;
  }
}

export function parseCuaFocusedPageElement(
  value: string | undefined,
): CuaFocusedPageElement | undefined {
  if (!value) return undefined;
  try {
    return focusedPageElement(JSON.parse(value));
  } catch {
    return undefined;
  }
}

async function listProcessListeningPorts(pid: number, signal: AbortSignal): Promise<number[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf8', signal, timeout: 2_000 },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      },
    );
  }).catch(() => '');
  const ports = stdout.split('\n').flatMap((line) => {
    if (!line.startsWith('n')) return [];
    const match = line.match(/:(\d+)$/);
    const port = match ? Number(match[1]) : 0;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? [port] : [];
  });
  return [...new Set(ports)];
}

async function fetchCdpPageTargets(port: number, signal: AbortSignal): Promise<CuaCdpPageTarget[]> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('CDP target discovery timed out')),
    800,
  );
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json = await response.json();
    if (!Array.isArray(json)) return [];
    return json.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const target = entry as Record<string, unknown>;
      if (
        target.type !== 'page' ||
        typeof target.url !== 'string' ||
        typeof target.title !== 'string' ||
        typeof target.webSocketDebuggerUrl !== 'string'
      )
        return [];
      return [
        {
          port,
          title: target.title,
          url: target.url,
          webSocketDebuggerUrl: target.webSocketDebuggerUrl,
        },
      ];
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function focusedPageElement(value: unknown): CuaFocusedPageElement {
  if (!value || typeof value !== 'object') {
    return { editable: false, value: '', tagName: '' };
  }
  const result = value as Record<string, unknown>;
  return {
    editable: result.editable === true,
    value: typeof result.value === 'string' ? result.value : '',
    tagName: typeof result.tagName === 'string' ? result.tagName : '',
    ...(typeof result.inputType === 'string' ? { inputType: result.inputType } : {}),
  };
}
