import { htmlToMarkdown } from '@jackwener/opencli/utils';
import {
  type BrowserBackend,
  type BrowserTarget,
  type BrowserToolSet,
  type BrowserWaitCondition,
  MAX_BROWSER_SELECTOR_CHARS,
  boundBrowserSnapshotForWire,
  buildBrowserTools as buildRuntimeBrowserTools,
} from '@maka/runtime';
import {
  type BrowserPageRun,
  type TakeoverMode,
  browserAutomationAvailable,
  detachBrowserSession,
  withBrowserPage,
} from './session.js';
import { parseNavigable } from './logic.js';

// Above opencli's internal 30s CDP guard so navigation surfaces its own timeout.
const NAVIGATE_TIMEOUT_MS = 35_000;
const HTML_CHAR_LIMIT = 2_000_000;
const CONNECTION_LOST = /CDP connection is not open|CDP connection closed|bridge closed/i;
const OPENCLI_SNAPSHOT_FOOTER = /^interactive: (0|[1-9]\d*) \| iframes: (0|[1-9]\d*)$/;
const OPENCLI_REF_TOKEN = /^ *(?:\*)?(?:\[([1-9]\d*)\]|\|scroll\[([1-9]\d*)\]\|)</;
const OPENCLI_BLOCKED_IFRAME_MARKER =
  '(blocked, use: opencli browser frames + browser eval --frame <index>)';

function metadataFallback<T>(error: unknown, fallback: T): T {
  if (error instanceof Error && CONNECTION_LOST.test(error.message)) throw error;
  return fallback;
}

async function runBrowserAction<T>(input: {
  sessionId: string;
  label: string;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  takeover?: TakeoverMode;
  effectful?: boolean;
  run: BrowserPageRun<T>;
}): Promise<T> {
  if (!browserAutomationAvailable()) {
    throw new Error('Browser automation is only available inside the desktop app.');
  }
  return withBrowserPage(input.sessionId, input.label, input.run, {
    abort: input.abortSignal,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.takeover ? { takeover: input.takeover } : {}),
    ...(input.effectful !== undefined ? { effectful: input.effectful } : {}),
  });
}

/** Translate the Runtime model target into opencli's local target representation. */
export function browserTargetToOpenCli(target: BrowserTarget): string {
  if (target.kind === 'selector') {
    if (!target.value || target.value.length > MAX_BROWSER_SELECTOR_CHARS) {
      throw new Error('Browser selector target is invalid.');
    }
    return target.value;
  }
  const match = /^\[(0|[1-9]\d*)\]$/.exec(target.value);
  if (!match) throw new Error(`Browser ref target is not a canonical decimal reference: ${JSON.stringify(target.value)}.`);
  return match[1];
}

function waitOptions(condition: BrowserWaitCondition): {
  options: { text?: string; selector?: string; time?: number; timeout?: number };
  timeoutMs: number;
  description: string;
} {
  switch (condition.kind) {
    case 'text':
      return {
        options: { text: condition.value, timeout: condition.timeoutSeconds },
        timeoutMs: (condition.timeoutSeconds + 5) * 1000,
        description: `text ${JSON.stringify(condition.value)}`,
      };
    case 'selector':
      return {
        options: { selector: condition.value, timeout: condition.timeoutSeconds },
        timeoutMs: (condition.timeoutSeconds + 5) * 1000,
        description: `selector ${JSON.stringify(condition.value)}`,
      };
    case 'time':
      return {
        options: { time: condition.seconds },
        timeoutMs: (condition.seconds + 5) * 1000,
        description: `${condition.seconds}s pause`,
      };
  }
}

function annotateOpenCliSnapshot(text: string): Array<{
  readonly text: string;
  readonly ref?: `[${string}]`;
}> {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const withoutRefs = () => lines.map((line) => ({ text: line }));
  const footer = OPENCLI_SNAPSHOT_FOOTER.exec(lines.at(-1) ?? '');
  if (
    !footer ||
    footer[2] !== '0' ||
    lines.some((line) => line.includes(OPENCLI_BLOCKED_IFRAME_MARKER))
  ) {
    return withoutRefs();
  }

  const interactiveCount = Number(footer[1]);
  if (!Number.isSafeInteger(interactiveCount)) return withoutRefs();

  const tokenByLine = new Map<number, string>();
  const occurrences = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const token = OPENCLI_REF_TOKEN.exec(line);
    const rawRef = token?.[1] ?? token?.[2];
    if (rawRef === undefined) continue;
    const refNumber = Number(rawRef);
    if (!Number.isSafeInteger(refNumber) || refNumber < 1 || refNumber > interactiveCount) continue;
    tokenByLine.set(index, rawRef);
    occurrences.set(rawRef, (occurrences.get(rawRef) ?? 0) + 1);
  }

  return lines.map((line, index) => {
    const rawRef = tokenByLine.get(index);
    return rawRef !== undefined && occurrences.get(rawRef) === 1
      ? { text: line, ref: `[${rawRef}]` as `[${string}]` }
      : { text: line };
  });
}

/** Current Desktop-native backend. BrowserView and CDP remain owned by Electron main. */
export function createLocalBrowserBackend(): BrowserBackend {
  return {
    async navigate({ url }, signal, context) {
      const navigable = parseNavigable(url);
      if (!navigable) {
        throw new Error(`Not a navigable URL: ${JSON.stringify(url)}. Pass a full http:// or https:// URL.`);
      }
      return runBrowserAction({
        sessionId: context.sessionId,
        label: 'navigate',
        abortSignal: signal,
        timeoutMs: NAVIGATE_TIMEOUT_MS,
        takeover: 'navigate',
        effectful: true,
        run: async (page, info) => {
          info.markEffectStarted();
          await page.goto(navigable, { waitUntil: 'load' });
          const landed = await page
            .evaluate<string>('window.location.href')
            .catch((error) => metadataFallback(error, navigable));
          const title = await page
            .evaluate<string>('document.title')
            .catch((error) => metadataFallback(error, ''));
          return {
            url: typeof landed === 'string' && landed ? landed : navigable,
            title: typeof title === 'string' ? title : '',
            takeoverReloaded: info.takeoverReloaded,
          };
        },
      });
    },

    async snapshot(signal, context) {
      return runBrowserAction({
        sessionId: context.sessionId,
        label: 'snapshot',
        abortSignal: signal,
        run: async (page, info) => {
          const snapshot = await page.snapshot({ interactive: true });
          const text =
            typeof snapshot === 'string' ? snapshot : (JSON.stringify(snapshot, null, 2) ?? '');
          return boundBrowserSnapshotForWire({
            url: (await page.getCurrentUrl?.()) ?? '',
            elements: annotateOpenCliSnapshot(text),
            takeoverReloaded: info.takeoverReloaded,
          });
        },
      });
    },

    async click({ target }, signal, context) {
      return runBrowserAction({
        sessionId: context.sessionId,
        label: 'click',
        abortSignal: signal,
        takeover: 'mutate',
        effectful: true,
        run: async (page, info) => {
          const openCliTarget = browserTargetToOpenCli(target);
          info.markEffectStarted();
          const outcome = await page.click(openCliTarget);
          return {
            matches: outcome.matches_n,
            matchLevel: outcome.match_level,
            takeoverReloaded: info.takeoverReloaded,
          };
        },
      });
    },

    async type({ target, text, submit }, signal, context) {
      return runBrowserAction({
        sessionId: context.sessionId,
        label: 'type',
        abortSignal: signal,
        takeover: 'mutate',
        effectful: true,
        run: async (page, info) => {
          const openCliTarget = browserTargetToOpenCli(target);
          info.markEffectStarted();
          const outcome = await page.fillText(openCliTarget, text);
          if (submit) await page.pressKey('Enter');
          return {
            verified: outcome.verified,
            actual: outcome.actual,
            matchLevel: outcome.match_level,
            takeoverReloaded: info.takeoverReloaded,
          };
        },
      });
    },

    async wait({ condition }, signal, context) {
      const { options, timeoutMs, description } = waitOptions(condition);
      return runBrowserAction({
        sessionId: context.sessionId,
        label: 'wait',
        abortSignal: signal,
        timeoutMs,
        run: async (page, info) => {
          try {
            await page.wait(options);
          } catch (error) {
            if (error instanceof Error && /Selector not found|Text not found/.test(error.message)) {
              const seconds = condition.kind === 'time' ? condition.seconds : condition.timeoutSeconds;
              throw new Error(
                `Waited ${seconds}s but ${description} never appeared. The page may be structured differently than expected — take a browser_snapshot to see what is actually there before retrying.`,
              );
            }
            throw error;
          }
          return { takeoverReloaded: info.takeoverReloaded };
        },
      });
    },

    async extract({ selector, start, limit }, signal, context) {
      return runBrowserAction({
        sessionId: context.sessionId,
        label: 'extract',
        abortSignal: signal,
        run: async (page, info) => {
          const read = await page.evaluate<{ html: string; truncated: boolean } | null>(
            readHtmlJs(JSON.stringify(selector ?? null)),
          );
          const markdown = typeof read?.html === 'string' ? htmlToMarkdown(read.html) : null;
          const chunk = markdown?.slice(start, start + limit) ?? null;
          const nextStart = start + (chunk?.length ?? 0);
          return {
            url: (await page.getCurrentUrl?.()) ?? '',
            chunk,
            hasMore: markdown !== null && nextStart < markdown.length,
            nextStart,
            sourceTruncated: read?.truncated ?? false,
            takeoverReloaded: info.takeoverReloaded,
          };
        },
      });
    },

    releaseTurnState: ({ sessionId }) => detachBrowserSession(sessionId),
  };
}

// Runs inside the page. The selector is JSON-serialized, so it cannot inject.
export function readHtmlJs(selectorJson: string): string {
  return `(() => {
  const selector = ${selectorJson};
  let el;
  try {
    el = selector ? document.querySelector(selector) : document.body;
  } catch {
    return null;
  }
  if (!el) return null;
  const html = el.outerHTML;
  return { html: html.slice(0, ${HTML_CHAR_LIMIT}), truncated: html.length > ${HTML_CHAR_LIMIT} };
})()`;
}

/** Runtime owns all six tool definitions; Desktop supplies only the local backend. */
export function buildBrowserTools(): BrowserToolSet {
  return buildRuntimeBrowserTools({ backend: createLocalBrowserBackend() });
}
