import { BROWSER_REVIEW_TEXT_MAX_UTF8_BYTES } from '@maka/core/browser';
import { requireCount, requireExactRecord, requireId, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';

export const NATIVE_PROVIDER_BROWSER_MAX_ADDRESS_INPUT_CHARS = 4_000;
// URL normalization may add "https://" and a trailing slash to a raw address.
export const NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS =
  NATIVE_PROVIDER_BROWSER_MAX_ADDRESS_INPUT_CHARS + 9;
export const NATIVE_PROVIDER_BROWSER_MAX_SELECTOR_CHARS = 2_000;
export const NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES = BROWSER_REVIEW_TEXT_MAX_UTF8_BYTES;
export const NATIVE_PROVIDER_BROWSER_MAX_WAIT_TEXT_UTF8_BYTES = BROWSER_REVIEW_TEXT_MAX_UTF8_BYTES;
export const NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_ELEMENTS = 200;
export const NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS = 16_000;
export const NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS = 16_000;
export const NATIVE_PROVIDER_BROWSER_MAX_WAIT_SECONDS = 120;
export const NATIVE_PROVIDER_BROWSER_MAX_RESULT_TEXT_UTF8_BYTES = 48 * 1024;
export const NATIVE_PROVIDER_BROWSER_MAX_RESULT_JSON_BYTES = 56 * 1024;

const MAX_TITLE_CHARS = 16_000;
const MAX_MATCH_LEVEL_CHARS = 128;

export interface NativeProviderBrowserContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

export interface BrowserSnapshotElement {
  readonly text: string;
  readonly ref?: `[${string}]`;
}

export type NativeProviderBrowserTarget =
  | { readonly kind: 'ref'; readonly value: `[${string}]` }
  | { readonly kind: 'selector'; readonly value: string };

export type NativeProviderBrowserWaitCondition =
  | { readonly kind: 'text'; readonly value: string; readonly timeoutSeconds: number }
  | { readonly kind: 'selector'; readonly value: string; readonly timeoutSeconds: number }
  | { readonly kind: 'time'; readonly seconds: number };

export type NativeProviderBrowserSubcall =
  | {
      readonly kind: 'navigate';
      readonly input: Readonly<{ url: string }>;
      readonly context: NativeProviderBrowserContext;
    }
  | { readonly kind: 'snapshot'; readonly context: NativeProviderBrowserContext }
  | {
      readonly kind: 'click';
      readonly input: Readonly<{ target: NativeProviderBrowserTarget }>;
      readonly context: NativeProviderBrowserContext;
    }
  | {
      readonly kind: 'type';
      readonly input: Readonly<{
        target: NativeProviderBrowserTarget;
        text: string;
        submit: boolean;
      }>;
      readonly context: NativeProviderBrowserContext;
    }
  | {
      readonly kind: 'wait';
      readonly input: Readonly<{ condition: NativeProviderBrowserWaitCondition }>;
      readonly context: NativeProviderBrowserContext;
    }
  | {
      readonly kind: 'extract';
      readonly input: Readonly<{ selector?: string; start: number; limit: number }>;
      readonly context: NativeProviderBrowserContext;
    };

interface NativeProviderBrowserTakeoverInfo {
  readonly takeoverReloaded: boolean;
}

export type NativeProviderBrowserResultPayload =
  | (Readonly<{ kind: 'navigate'; url: string; title: string }> & NativeProviderBrowserTakeoverInfo)
  | (Readonly<{
      kind: 'snapshot';
      url: string;
      elements: readonly BrowserSnapshotElement[];
      totalElements: number;
    }> &
      NativeProviderBrowserTakeoverInfo)
  | (Readonly<{ kind: 'click'; matches: number; matchLevel: string }> &
      NativeProviderBrowserTakeoverInfo)
  | (Readonly<{ kind: 'type'; verified: boolean; actual: string; matchLevel: string }> &
      NativeProviderBrowserTakeoverInfo)
  | (Readonly<{ kind: 'wait' }> & NativeProviderBrowserTakeoverInfo)
  | (Readonly<{
      kind: 'extract';
      url: string;
      chunk: string | null;
      hasMore: boolean;
      nextStart: number;
      sourceTruncated: boolean;
    }> &
      NativeProviderBrowserTakeoverInfo);

export function decodeNativeProviderBrowserSubcall(value: unknown): NativeProviderBrowserSubcall {
  const subcall = requireRecord(value, 'native Provider Browser subcall');
  const context = () => decodeContext(subcall.context);
  switch (subcall.kind) {
    case 'navigate': {
      const decoded = requireExactRecord(subcall, 'native Provider Browser navigate subcall', [
        'kind',
        'input',
        'context',
      ]);
      const input = requireExactRecord(decoded.input, 'native Provider Browser navigate input', [
        'url',
      ]);
      return {
        kind: 'navigate',
        input: {
          url: boundedNonEmpty(input.url, 'Browser URL', NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS),
        },
        context: context(),
      };
    }
    case 'snapshot':
      requireExactRecord(subcall, 'native Provider Browser snapshot subcall', ['kind', 'context']);
      return { kind: 'snapshot', context: context() };
    case 'click': {
      const decoded = requireExactRecord(subcall, 'native Provider Browser click subcall', [
        'kind',
        'input',
        'context',
      ]);
      const input = requireExactRecord(decoded.input, 'native Provider Browser click input', [
        'target',
      ]);
      return { kind: 'click', input: { target: decodeTarget(input.target) }, context: context() };
    }
    case 'type': {
      const decoded = requireExactRecord(subcall, 'native Provider Browser type subcall', [
        'kind',
        'input',
        'context',
      ]);
      const input = requireExactRecord(decoded.input, 'native Provider Browser type input', [
        'target',
        'text',
        'submit',
      ]);
      return {
        kind: 'type',
        input: {
          target: decodeTarget(input.target),
          text: utf8Text(
            input.text,
            'Browser type text',
            NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES,
          ),
          submit: boolean(input.submit, 'Browser type submit'),
        },
        context: context(),
      };
    }
    case 'wait': {
      const decoded = requireExactRecord(subcall, 'native Provider Browser wait subcall', [
        'kind',
        'input',
        'context',
      ]);
      const input = requireExactRecord(decoded.input, 'native Provider Browser wait input', [
        'condition',
      ]);
      return {
        kind: 'wait',
        input: { condition: decodeWaitCondition(input.condition) },
        context: context(),
      };
    }
    case 'extract': {
      const decoded = requireExactRecord(subcall, 'native Provider Browser extract subcall', [
        'kind',
        'input',
        'context',
      ]);
      const inputRecord = requireRecord(decoded.input, 'native Provider Browser extract input');
      const keys = Object.hasOwn(inputRecord, 'selector')
        ? ['selector', 'start', 'limit']
        : ['start', 'limit'];
      const input = requireExactRecord(inputRecord, 'native Provider Browser extract input', keys);
      const limit = positiveInteger(input.limit, 'Browser extract limit');
      if (limit > NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS) {
        throw invalidProtocolFrame('Invalid Browser extract limit');
      }
      return {
        kind: 'extract',
        input: {
          ...(input.selector === undefined
            ? {}
            : {
                selector: boundedNonEmpty(
                  input.selector,
                  'Browser selector',
                  NATIVE_PROVIDER_BROWSER_MAX_SELECTOR_CHARS,
                ),
              }),
          start: requireCount(input.start, 'Browser extract start'),
          limit,
        },
        context: context(),
      };
    }
    default:
      throw invalidProtocolFrame('Invalid Native Provider Browser subcall kind');
  }
}

export function decodeNativeProviderBrowserResultPayload(
  value: unknown,
): NativeProviderBrowserResultPayload {
  const result = requireRecord(value, 'native Provider Browser result payload');
  let decoded: NativeProviderBrowserResultPayload;
  switch (result.kind) {
    case 'navigate': {
      const fields = exactResult(result, 'navigate', ['url', 'title']);
      decoded = {
        kind: 'navigate',
        url: boundedText(fields.url, 'Browser result URL', NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS),
        title: boundedText(fields.title, 'Browser result title', MAX_TITLE_CHARS),
        takeoverReloaded: boolean(fields.takeoverReloaded, 'Browser result takeoverReloaded'),
      };
      break;
    }
    case 'snapshot': {
      const fields = exactResult(result, 'snapshot', ['url', 'elements', 'totalElements']);
      if (
        !Array.isArray(fields.elements) ||
        fields.elements.length > NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_ELEMENTS
      ) {
        throw invalidProtocolFrame('Invalid Browser snapshot elements');
      }
      const refs = new Set<string>();
      const elements = fields.elements.map((element) => snapshotElement(element, refs));
      const totalElements = requireCount(fields.totalElements, 'Browser snapshot totalElements');
      if (totalElements < elements.length) {
        throw invalidProtocolFrame('Browser snapshot totalElements is smaller than its prefix');
      }
      if (
        elements.reduce((total, element) => total + element.text.length, 0) >
        NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS
      ) {
        throw invalidProtocolFrame('Browser snapshot exceeds character limit');
      }
      if (
        utf8Bytes(elements.map(({ text }) => text).join('')) >
        NATIVE_PROVIDER_BROWSER_MAX_RESULT_TEXT_UTF8_BYTES
      ) {
        throw invalidProtocolFrame('Browser snapshot exceeds UTF-8 byte limit');
      }
      decoded = {
        kind: 'snapshot',
        url: boundedText(fields.url, 'Browser result URL', NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS),
        elements,
        totalElements,
        takeoverReloaded: boolean(fields.takeoverReloaded, 'Browser result takeoverReloaded'),
      };
      break;
    }
    case 'click': {
      const fields = exactResult(result, 'click', ['matches', 'matchLevel']);
      decoded = {
        kind: 'click',
        matches: requireCount(fields.matches, 'Browser click matches'),
        matchLevel: boundedNonEmpty(
          fields.matchLevel,
          'Browser match level',
          MAX_MATCH_LEVEL_CHARS,
        ),
        takeoverReloaded: boolean(fields.takeoverReloaded, 'Browser result takeoverReloaded'),
      };
      break;
    }
    case 'type': {
      const fields = exactResult(result, 'type', ['verified', 'actual', 'matchLevel']);
      decoded = {
        kind: 'type',
        verified: boolean(fields.verified, 'Browser type verified'),
        actual: utf8Text(
          fields.actual,
          'Browser type actual',
          NATIVE_PROVIDER_BROWSER_MAX_TYPE_TEXT_UTF8_BYTES,
        ),
        matchLevel: boundedNonEmpty(
          fields.matchLevel,
          'Browser match level',
          MAX_MATCH_LEVEL_CHARS,
        ),
        takeoverReloaded: boolean(fields.takeoverReloaded, 'Browser result takeoverReloaded'),
      };
      break;
    }
    case 'wait': {
      const fields = exactResult(result, 'wait', []);
      decoded = {
        kind: 'wait',
        takeoverReloaded: boolean(fields.takeoverReloaded, 'Browser result takeoverReloaded'),
      };
      break;
    }
    case 'extract': {
      const fields = exactResult(result, 'extract', [
        'url',
        'chunk',
        'hasMore',
        'nextStart',
        'sourceTruncated',
      ]);
      const chunk =
        fields.chunk === null
          ? null
          : boundedText(
              fields.chunk,
              'Browser extract chunk',
              NATIVE_PROVIDER_BROWSER_MAX_EXTRACT_CHARS,
            );
      if (chunk !== null && utf8Bytes(chunk) > NATIVE_PROVIDER_BROWSER_MAX_RESULT_TEXT_UTF8_BYTES) {
        throw invalidProtocolFrame('Browser extract chunk exceeds UTF-8 byte limit');
      }
      decoded = {
        kind: 'extract',
        url: boundedText(fields.url, 'Browser result URL', NATIVE_PROVIDER_BROWSER_MAX_URL_CHARS),
        chunk,
        hasMore: boolean(fields.hasMore, 'Browser extract hasMore'),
        nextStart: requireCount(fields.nextStart, 'Browser extract nextStart'),
        sourceTruncated: boolean(fields.sourceTruncated, 'Browser extract sourceTruncated'),
        takeoverReloaded: boolean(fields.takeoverReloaded, 'Browser result takeoverReloaded'),
      };
      break;
    }
    default:
      throw invalidProtocolFrame('Invalid Native Provider Browser result kind');
  }
  if (utf8Bytes(JSON.stringify(decoded)) > NATIVE_PROVIDER_BROWSER_MAX_RESULT_JSON_BYTES) {
    throw invalidProtocolFrame('Browser result exceeds wire byte budget');
  }
  return decoded;
}

function decodeContext(value: unknown): NativeProviderBrowserContext {
  const context = requireExactRecord(value, 'native Provider Browser context', [
    'sessionId',
    'turnId',
    'toolCallId',
  ]);
  return {
    sessionId: requireId(context.sessionId, 'sessionId'),
    turnId: requireId(context.turnId, 'turnId'),
    toolCallId: requireId(context.toolCallId, 'toolCallId'),
  };
}

function decodeTarget(value: unknown): NativeProviderBrowserTarget {
  const target = requireExactRecord(value, 'native Provider Browser target', ['kind', 'value']);
  if (target.kind === 'ref') {
    const ref = boundedNonEmpty(
      target.value,
      'Browser ref',
      NATIVE_PROVIDER_BROWSER_MAX_SELECTOR_CHARS,
    );
    if (!/^\[(0|[1-9]\d*)\]$/.test(ref)) throw invalidProtocolFrame('Invalid Browser ref');
    return { kind: 'ref', value: ref as `[${string}]` };
  }
  if (target.kind === 'selector') {
    return {
      kind: 'selector',
      value: boundedNonEmpty(
        target.value,
        'Browser selector',
        NATIVE_PROVIDER_BROWSER_MAX_SELECTOR_CHARS,
      ),
    };
  }
  throw invalidProtocolFrame('Invalid Browser target kind');
}

function decodeWaitCondition(value: unknown): NativeProviderBrowserWaitCondition {
  const condition = requireRecord(value, 'native Provider Browser wait condition');
  if (condition.kind === 'time') {
    const time = requireExactRecord(condition, 'native Provider Browser time wait', [
      'kind',
      'seconds',
    ]);
    return { kind: 'time', seconds: waitSeconds(time.seconds) };
  }
  if (condition.kind === 'text' || condition.kind === 'selector') {
    const bounded = requireExactRecord(condition, 'native Provider Browser bounded wait', [
      'kind',
      'value',
      'timeoutSeconds',
    ]);
    const timeoutSeconds = waitSeconds(bounded.timeoutSeconds);
    if (condition.kind === 'text') {
      return {
        kind: 'text',
        value: utf8NonEmptyText(
          bounded.value,
          'Browser wait text',
          NATIVE_PROVIDER_BROWSER_MAX_WAIT_TEXT_UTF8_BYTES,
        ),
        timeoutSeconds,
      };
    }
    return {
      kind: 'selector',
      value: boundedNonEmpty(
        bounded.value,
        'Browser selector',
        NATIVE_PROVIDER_BROWSER_MAX_SELECTOR_CHARS,
      ),
      timeoutSeconds,
    };
  }
  throw invalidProtocolFrame('Invalid Browser wait condition kind');
}

function exactResult(
  value: Record<string, unknown>,
  kind: NativeProviderBrowserResultPayload['kind'],
  fields: readonly string[],
): Record<string, unknown> {
  return requireExactRecord(value, `native Provider Browser ${kind} result`, [
    'kind',
    ...fields,
    'takeoverReloaded',
  ]);
}

function waitSeconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > NATIVE_PROVIDER_BROWSER_MAX_WAIT_SECONDS
  ) {
    throw invalidProtocolFrame('Invalid Browser wait seconds');
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const integer = requireCount(value, label);
  if (integer === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return integer;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function boundedNonEmpty(value: unknown, label: string, maxChars: number): string {
  const text = boundedText(value, label, maxChars);
  if (text.length === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return text;
}

function boundedText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length > maxChars) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function utf8Text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || utf8Bytes(value) > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function utf8NonEmptyText(value: unknown, label: string, maxBytes: number): string {
  const text = utf8Text(value, label, maxBytes);
  if (text.length === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return text;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function snapshotElement(value: unknown, refs: Set<string>): BrowserSnapshotElement {
  const record = requireRecord(value, 'Browser snapshot element');
  const hasRef = Object.hasOwn(record, 'ref');
  const fields = requireExactRecord(
    record,
    'Browser snapshot element',
    hasRef ? ['text', 'ref'] : ['text'],
  );
  const text = boundedNonEmpty(
    fields.text,
    'Browser snapshot line',
    NATIVE_PROVIDER_BROWSER_MAX_SNAPSHOT_CHARS,
  );
  if (text.includes('\n') || text.includes('\r')) {
    throw invalidProtocolFrame('Browser snapshot elements must be whole lines');
  }
  if (!hasRef) return { text };
  if (typeof fields.ref !== 'string' || !/^\[[1-9]\d*\]$/.test(fields.ref)) {
    throw invalidProtocolFrame('Invalid Browser snapshot element ref');
  }
  const lineRef = openCliLineRef(text);
  if (lineRef !== fields.ref) {
    throw invalidProtocolFrame('Browser snapshot element ref does not match its text');
  }
  if (refs.has(fields.ref)) {
    throw invalidProtocolFrame('Duplicate Browser snapshot element ref');
  }
  refs.add(fields.ref);
  return { text, ref: fields.ref as `[${string}]` };
}

function openCliLineRef(text: string): string | undefined {
  const match = /^ *(?:\*)?(?:\[([1-9]\d*)\]|\|scroll\[([1-9]\d*)\]\|)</.exec(text);
  const decimal = match?.[1] ?? match?.[2];
  return decimal === undefined ? undefined : `[${decimal}]`;
}
