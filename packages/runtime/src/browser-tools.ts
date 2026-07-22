import { Buffer } from 'node:buffer';
import {
  BROWSER_REVIEW_TEXT_MAX_UTF8_BYTES,
  normalizeBrowserAddressInput,
} from '@maka/core/browser';
import { isBrowserPermissionReviewTextRepresentable } from '@maka/core/interaction';
import { z } from 'zod';
import type { MakaTool, MakaToolContext, MakaToolExecutionReservation } from './tool-runtime.js';

const BROWSER_TOOL_CATEGORY = 'browser' as const;
const MAX_WAIT_SECONDS = 120;
const EXTRACT_CHAR_LIMIT = 16_000;
const MAX_BROWSER_TITLE_CHARS = 16_000;
const MAX_BROWSER_MATCH_LEVEL_CHARS = 128;
const MAX_BROWSER_BACKEND_RESULT_UTF8_BYTES = 56 * 1024;
const MAX_BROWSER_RESULT_TEXT_UTF8_BYTES = 48 * 1024;

export const MAX_BROWSER_ADDRESS_INPUT_CHARS = 4_000;
// URL normalization may add "https://" and a trailing slash.
export const MAX_BROWSER_URL_CHARS = MAX_BROWSER_ADDRESS_INPUT_CHARS + 9;
export const MAX_BROWSER_SNAPSHOT_CHARS = 16_000;
export const MAX_BROWSER_SNAPSHOT_ELEMENTS = 200;
export const MAX_BROWSER_SELECTOR_CHARS = 2_000;
export const MAX_BROWSER_TYPE_TEXT_UTF8_BYTES = BROWSER_REVIEW_TEXT_MAX_UTF8_BYTES;
export const MAX_BROWSER_WAIT_TEXT_UTF8_BYTES = BROWSER_REVIEW_TEXT_MAX_UTF8_BYTES;

export type BrowserTarget =
  | { kind: 'ref'; value: `[${string}]` }
  | { kind: 'selector'; value: string };

export interface BrowserInvocationContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  operationId?: string;
}

export interface BrowserTakeoverInfo {
  takeoverReloaded: boolean;
}

export interface BrowserNavigateResult extends BrowserTakeoverInfo {
  url: string;
  title: string;
}

export interface BrowserSnapshotElement {
  readonly text: string;
  readonly ref?: `[${string}]`;
}

export interface BrowserSnapshotResult extends BrowserTakeoverInfo {
  url: string;
  /** One model-readable snapshot line per entry, in page order. */
  elements: readonly BrowserSnapshotElement[];
  /** Number of elements in the complete source snapshot before wire bounding. */
  totalElements: number;
}

/**
 * Bound a complete native snapshot to the ordinary inline Browser wire frame.
 * This keeps only whole entries; model-facing truncation text remains owned by
 * the Runtime projection.
 */
export function boundBrowserSnapshotForWire(
  input: Omit<BrowserSnapshotResult, 'totalElements'> & { totalElements?: number },
): BrowserSnapshotResult {
  if (!Array.isArray(input.elements)) {
    throw new Error('Browser snapshot elements must be an array.');
  }
  const totalElements = input.totalElements ?? input.elements.length;
  if (
    !Number.isSafeInteger(totalElements) ||
    totalElements < 0 ||
    totalElements < input.elements.length
  ) {
    throw new Error('Browser snapshot totalElements must cover its source entries.');
  }

  const elements: BrowserSnapshotElement[] = [];
  const refs = new Set<string>();
  let characters = 0;
  let utf8Bytes = 0;
  let boundingComplete = false;
  for (const [index, rawElement] of input.elements.entries()) {
    const element = validateSnapshotElement(rawElement, index, refs, (detail) => {
      throw new Error(`Invalid Browser snapshot element: ${detail}.`);
    });
    if (boundingComplete) continue;
    const nextCharacters = characters + element.text.length;
    const nextUtf8Bytes = utf8Bytes + Buffer.byteLength(element.text, 'utf8');
    const nextElements = [...elements, element];
    const nextWireBytes = Buffer.byteLength(
      JSON.stringify({
        kind: 'snapshot',
        url: input.url,
        elements: nextElements,
        totalElements,
        takeoverReloaded: input.takeoverReloaded,
      }),
      'utf8',
    );
    if (
      elements.length >= MAX_BROWSER_SNAPSHOT_ELEMENTS ||
      nextCharacters > MAX_BROWSER_SNAPSHOT_CHARS ||
      nextUtf8Bytes > MAX_BROWSER_RESULT_TEXT_UTF8_BYTES ||
      nextWireBytes > MAX_BROWSER_BACKEND_RESULT_UTF8_BYTES
    ) {
      boundingComplete = true;
      continue;
    }
    elements.push(element);
    characters = nextCharacters;
    utf8Bytes = nextUtf8Bytes;
  }
  return {
    url: input.url,
    elements,
    totalElements,
    takeoverReloaded: input.takeoverReloaded,
  };
}

function validateSnapshotElement(
  value: unknown,
  index: number,
  refs: Set<string>,
  invalid: (detail: string) => never,
): BrowserSnapshotElement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`elements[${index}] must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`elements[${index}] must be a plain record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== 'string' || (key !== 'text' && key !== 'ref')) ||
    !Object.hasOwn(descriptors, 'text')
  ) {
    return invalid(`elements[${index}] fields do not match the backend contract`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return invalid(`elements[${index}] must contain enumerable own data properties`);
    }
  }
  const text = descriptors.text?.value;
  if (typeof text !== 'string' || text.length === 0 || /[\r\n]/.test(text)) {
    return invalid(`elements[${index}].text must be one non-empty complete line`);
  }
  if (!Object.hasOwn(descriptors, 'ref')) return { text };
  const ref = descriptors.ref?.value;
  if (typeof ref !== 'string' || !/^\[[1-9]\d*\]$/.test(ref)) {
    return invalid(`elements[${index}].ref must be a canonical positive decimal ref`);
  }
  const token = /^ *(?:\*)?(?:\[([1-9]\d*)\]<|\|scroll\[([1-9]\d*)\]\|<)/.exec(text);
  const textRef = token?.[1] ?? token?.[2];
  if (textRef === undefined || ref !== `[${textRef}]`) {
    return invalid(`elements[${index}].ref does not match its OpenCLI text token`);
  }
  if (refs.has(ref)) return invalid(`elements[${index}].ref duplicates ${ref}`);
  refs.add(ref);
  return { text, ref: ref as `[${string}]` };
}

export interface BrowserClickResult extends BrowserTakeoverInfo {
  matches: number;
  matchLevel: string;
}

export interface BrowserTypeResult extends BrowserTakeoverInfo {
  verified: boolean;
  actual: string;
  matchLevel: string;
}

export type BrowserWaitCondition =
  | { kind: 'text'; value: string; timeoutSeconds: number }
  | { kind: 'selector'; value: string; timeoutSeconds: number }
  | { kind: 'time'; seconds: number };

export interface BrowserExtractResult extends BrowserTakeoverInfo {
  url: string;
  /** Markdown page bounded by the requested extraction limit; null means no readable match. */
  chunk: string | null;
  hasMore: boolean;
  nextStart: number;
  sourceTruncated: boolean;
}

export interface BrowserTurnIdentity {
  sessionId: string;
  turnId: string;
}

export type BrowserBackendErrorCode =
  | 'outcome_unknown'
  | 'service_unavailable'
  | 'service_mismatch';

/** Typed native failure. The code is also retained in ToolRuntime's text-only error projection. */
export class BrowserBackendError extends Error {
  constructor(
    readonly code: BrowserBackendErrorCode,
    message: string,
  ) {
    super(`Browser backend ${code}: ${message}`);
    this.name = 'BrowserBackendError';
  }
}

function normalizeBrowserBackendError(error: unknown): BrowserBackendError | undefined {
  if (error instanceof BrowserBackendError) return error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  if (code !== 'outcome_unknown' && code !== 'service_unavailable' && code !== 'service_mismatch') {
    return undefined;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'Native browser operation failed.';
  return new BrowserBackendError(code, message);
}

/** Per-invocation native operations. It owns page handles, not tool policy or projection. */
export interface BrowserBackendOperations {
  navigate(
    input: { url: string },
    signal: AbortSignal,
    context: BrowserInvocationContext,
  ): Promise<BrowserNavigateResult>;
  snapshot(signal: AbortSignal, context: BrowserInvocationContext): Promise<BrowserSnapshotResult>;
  click(
    input: { target: BrowserTarget },
    signal: AbortSignal,
    context: BrowserInvocationContext,
  ): Promise<BrowserClickResult>;
  type(
    input: { target: BrowserTarget; text: string; submit: boolean },
    signal: AbortSignal,
    context: BrowserInvocationContext,
  ): Promise<BrowserTypeResult>;
  wait(
    input: { condition: BrowserWaitCondition },
    signal: AbortSignal,
    context: BrowserInvocationContext,
  ): Promise<BrowserTakeoverInfo>;
  extract(
    input: { selector?: string; start: number; limit: number },
    signal: AbortSignal,
    context: BrowserInvocationContext,
  ): Promise<BrowserExtractResult>;
}

/** Long-lived Browser backend with the Turn cleanup boundary. */
export interface BrowserBackend extends BrowserBackendOperations {
  /** Turn cleanup detaches automation only; the page and its history remain alive. */
  releaseTurnState(input: BrowserTurnIdentity): Promise<void>;
}

export interface BrowserBackendInvocation {
  backend: BrowserBackendOperations;
  /** Opaque Provider binding retained for the lifetime of one Browser Turn. */
  affinity: BrowserBackendAffinity;
  /** One-way invocation cleanup; it cannot change the tool result. */
  release(): void;
}

export type BrowserBackendAffinity = string;

export type BrowserBackendInvocationAcquisition =
  | { ok: true; invocation: BrowserBackendInvocation }
  | { ok: false; error: 'service_unavailable' | 'service_mismatch'; message: string };

export interface BrowserBackendInvocationProvider {
  acquire(
    input: {
      context: BrowserInvocationContext & { operationId: string };
      affinity?: BrowserBackendAffinity;
    },
    signal: AbortSignal,
  ): Promise<BrowserBackendInvocationAcquisition>;
}

export interface BrowserToolSet extends Array<MakaTool> {
  releaseTurnState(input: BrowserTurnIdentity): Promise<void>;
}

const browserTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ref'),
      value: z
        .string()
        .regex(/^\[(0|[1-9]\d*)\]$/)
        .max(2000)
        .describe('Canonical decimal element reference from browser_snapshot, such as "[12]".'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('selector'),
      value: z
        .string()
        .min(1)
        .max(MAX_BROWSER_SELECTOR_CHARS)
        .describe(
          `CSS selector for the target element; at most ${MAX_BROWSER_SELECTOR_CHARS} characters.`,
        ),
    })
    .strict(),
]);

const browserNavigateParameters = z
  .object({
    url: z
      .string()
      .min(1)
      .max(MAX_BROWSER_ADDRESS_INPUT_CHARS)
      .describe('Full http:// or https:// URL to open. Other schemes are rejected.'),
  })
  .strict();

const browserTypeParameters = z
  .object({
    target: browserTargetSchema,
    text: z
      .string()
      .max(MAX_BROWSER_TYPE_TEXT_UTF8_BYTES)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_BROWSER_TYPE_TEXT_UTF8_BYTES, {
        message: `Text must be at most ${MAX_BROWSER_TYPE_TEXT_UTF8_BYTES} UTF-8 bytes.`,
      })
      .refine((value) => isBrowserPermissionReviewTextRepresentable(value, { allowEmpty: true }), {
        message: `Text must fit the ${MAX_BROWSER_TYPE_TEXT_UTF8_BYTES}-byte Browser permission review.`,
      })
      .describe(
        `Text to fill in; replaces the field's current content. Maximum ${MAX_BROWSER_TYPE_TEXT_UTF8_BYTES} UTF-8 bytes.`,
      ),
    submit: z.boolean().optional().describe('Press Enter after filling. Default false.'),
  })
  .strict();

const browserWaitParameters = z
  .object({
    text: z
      .string()
      .max(MAX_BROWSER_WAIT_TEXT_UTF8_BYTES)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_BROWSER_WAIT_TEXT_UTF8_BYTES, {
        message: `Text must be at most ${MAX_BROWSER_WAIT_TEXT_UTF8_BYTES} UTF-8 bytes.`,
      })
      .refine((value) => isBrowserPermissionReviewTextRepresentable(value), {
        message: `Text must fit the ${MAX_BROWSER_WAIT_TEXT_UTF8_BYTES}-byte Browser permission review.`,
      })
      .optional()
      .describe(
        `Wait until this text is visible on the page; at most ${MAX_BROWSER_WAIT_TEXT_UTF8_BYTES} UTF-8 bytes.`,
      ),
    selector: z
      .string()
      .max(MAX_BROWSER_SELECTOR_CHARS)
      .optional()
      .describe(
        `Wait until this CSS selector matches an element; at most ${MAX_BROWSER_SELECTOR_CHARS} characters.`,
      ),
    time: z.number().optional().describe('Fixed pause in seconds.'),
    timeout: z.number().optional().describe('Wait limit in seconds for text/selector waits.'),
  })
  .strict();

const browserExtractParameters = z
  .object({
    selector: z
      .string()
      .max(MAX_BROWSER_SELECTOR_CHARS)
      .optional()
      .describe(
        `CSS selector to extract from; omit for the whole page body. At most ${MAX_BROWSER_SELECTOR_CHARS} characters.`,
      ),
    start: z
      .number()
      .optional()
      .describe("Character offset to continue from (use the previous call's next_start_char)."),
  })
  .strict();

function invocationContext(context: MakaToolContext): BrowserInvocationContext {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
    ...(context.operationId ? { operationId: context.operationId } : {}),
  };
}

function takeoverNote(info: BrowserTakeoverInfo): string {
  return info.takeoverReloaded
    ? '\n\nNote: attached to the page that was already open; it was reloaded once to apply automation hardening.'
    : '';
}

function invalidBackendResult(kind: string, detail: string): never {
  throw new Error(`Invalid Browser ${kind} backend result: ${detail}.`);
}

function backendResultRecord(
  value: unknown,
  kind: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidBackendResult(kind, 'expected an object');
  }
  const record = value as Record<string, unknown>;
  const expected = new Set([...fields, 'takeoverReloaded']);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((field) => !expected.has(field))
  ) {
    return invalidBackendResult(kind, 'fields do not match the backend contract');
  }
  return record;
}

function backendBoolean(value: unknown, kind: string, field: string): boolean {
  if (typeof value !== 'boolean') return invalidBackendResult(kind, `${field} must be boolean`);
  return value;
}

function backendString(
  value: unknown,
  kind: string,
  field: string,
  options: { maxChars: number; maxUtf8Bytes?: number; nonEmpty?: boolean },
): string {
  if (typeof value !== 'string' || (options.nonEmpty && value.length === 0)) {
    return invalidBackendResult(
      kind,
      `${field} must be ${options.nonEmpty ? 'a non-empty ' : ''}string`,
    );
  }
  if (value.length > options.maxChars) {
    return invalidBackendResult(kind, `${field} exceeds ${options.maxChars} characters`);
  }
  if (
    options.maxUtf8Bytes !== undefined &&
    Buffer.byteLength(value, 'utf8') > options.maxUtf8Bytes
  ) {
    return invalidBackendResult(kind, `${field} exceeds ${options.maxUtf8Bytes} UTF-8 bytes`);
  }
  return value;
}

function backendCount(value: unknown, kind: string, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalidBackendResult(kind, `${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertBackendWireBudget(kind: string, result: object): void {
  let encoded: string;
  try {
    const serialized = JSON.stringify({ kind, ...result });
    if (typeof serialized !== 'string') {
      return invalidBackendResult(kind, 'result is not JSON-encodable');
    }
    encoded = serialized;
  } catch {
    return invalidBackendResult(kind, 'result is not JSON-encodable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BROWSER_BACKEND_RESULT_UTF8_BYTES) {
    invalidBackendResult(
      kind,
      `result exceeds ${MAX_BROWSER_BACKEND_RESULT_UTF8_BYTES} UTF-8 wire bytes`,
    );
  }
}

function backendTakeover(record: Record<string, unknown>, kind: string): BrowserTakeoverInfo {
  return {
    takeoverReloaded: backendBoolean(record.takeoverReloaded, kind, 'takeoverReloaded'),
  };
}

function backendUrl(value: unknown, kind: string): string {
  return backendString(value, kind, 'url', { maxChars: MAX_BROWSER_URL_CHARS });
}

function validateNavigateResult(value: unknown): BrowserNavigateResult {
  const kind = 'navigate';
  const record = backendResultRecord(value, kind, ['url', 'title']);
  const result = {
    url: backendUrl(record.url, kind),
    title: backendString(record.title, kind, 'title', { maxChars: MAX_BROWSER_TITLE_CHARS }),
    ...backendTakeover(record, kind),
  };
  assertBackendWireBudget(kind, result);
  return result;
}

function validateSnapshotResult(value: unknown): BrowserSnapshotResult {
  const kind = 'snapshot';
  const record = backendResultRecord(value, kind, ['url', 'elements', 'totalElements']);
  const rawElements = record.elements;
  if (!Array.isArray(rawElements) || rawElements.length > MAX_BROWSER_SNAPSHOT_ELEMENTS) {
    return invalidBackendResult(kind, 'elements must be an array');
  }
  const url = backendUrl(record.url, kind);
  const takeover = backendTakeover(record, kind);
  const elements: BrowserSnapshotElement[] = [];
  const refs = new Set<string>();
  let elementCharacters = 0;
  let elementUtf8Bytes = 0;
  for (const [index, rawElement] of rawElements.entries()) {
    const element = validateSnapshotElement(rawElement, index, refs, (detail) =>
      invalidBackendResult(kind, detail),
    );
    elementCharacters += element.text.length;
    elementUtf8Bytes += Buffer.byteLength(element.text, 'utf8');
    elements.push(element);
  }
  if (elementCharacters > MAX_BROWSER_SNAPSHOT_CHARS) {
    return invalidBackendResult(kind, 'elements exceed the snapshot character limit');
  }
  if (elementUtf8Bytes > MAX_BROWSER_RESULT_TEXT_UTF8_BYTES) {
    return invalidBackendResult(kind, 'elements exceed the snapshot UTF-8 byte limit');
  }
  const totalElements = backendCount(record.totalElements, kind, 'totalElements');
  if (totalElements < elements.length) {
    return invalidBackendResult(kind, 'totalElements is smaller than the bounded prefix');
  }
  const result: BrowserSnapshotResult = { url, elements, totalElements, ...takeover };
  assertBackendWireBudget(kind, result);
  return result;
}

function validateClickResult(value: unknown): BrowserClickResult {
  const kind = 'click';
  const record = backendResultRecord(value, kind, ['matches', 'matchLevel']);
  const result = {
    matches: backendCount(record.matches, kind, 'matches'),
    matchLevel: backendString(record.matchLevel, kind, 'matchLevel', {
      maxChars: MAX_BROWSER_MATCH_LEVEL_CHARS,
      nonEmpty: true,
    }),
    ...backendTakeover(record, kind),
  };
  assertBackendWireBudget(kind, result);
  return result;
}

function validateTypeResult(value: unknown): BrowserTypeResult {
  const kind = 'type';
  const record = backendResultRecord(value, kind, ['verified', 'actual', 'matchLevel']);
  const result = {
    verified: backendBoolean(record.verified, kind, 'verified'),
    actual: backendString(record.actual, kind, 'actual', {
      maxChars: MAX_BROWSER_TYPE_TEXT_UTF8_BYTES,
      maxUtf8Bytes: MAX_BROWSER_TYPE_TEXT_UTF8_BYTES,
    }),
    matchLevel: backendString(record.matchLevel, kind, 'matchLevel', {
      maxChars: MAX_BROWSER_MATCH_LEVEL_CHARS,
      nonEmpty: true,
    }),
    ...backendTakeover(record, kind),
  };
  assertBackendWireBudget(kind, result);
  return result;
}

function validateWaitResult(value: unknown): BrowserTakeoverInfo {
  const kind = 'wait';
  const result = backendTakeover(backendResultRecord(value, kind, []), kind);
  assertBackendWireBudget(kind, result);
  return result;
}

function validateExtractResult(
  value: unknown,
  request: { start: number; limit: number },
): BrowserExtractResult {
  const kind = 'extract';
  const record = backendResultRecord(value, kind, [
    'url',
    'chunk',
    'hasMore',
    'nextStart',
    'sourceTruncated',
  ]);
  const chunk =
    record.chunk === null
      ? null
      : backendString(record.chunk, kind, 'chunk', {
          maxChars: request.limit,
          maxUtf8Bytes: MAX_BROWSER_RESULT_TEXT_UTF8_BYTES,
        });
  const hasMore = backendBoolean(record.hasMore, kind, 'hasMore');
  const nextStart = backendCount(record.nextStart, kind, 'nextStart');
  const expectedNextStart = request.start + (chunk?.length ?? 0);
  if (!Number.isSafeInteger(expectedNextStart) || nextStart !== expectedNextStart) {
    return invalidBackendResult(kind, 'nextStart does not continue from the requested start');
  }
  if (chunk === null && hasMore) {
    return invalidBackendResult(kind, 'a null chunk cannot have more content');
  }
  if (chunk === '' && hasMore) {
    return invalidBackendResult(kind, 'continuation must make forward progress');
  }
  const result = {
    url: backendUrl(record.url, kind),
    chunk,
    hasMore,
    nextStart,
    sourceTruncated: backendBoolean(record.sourceTruncated, kind, 'sourceTruncated'),
    ...backendTakeover(record, kind),
  };
  assertBackendWireBudget(kind, result);
  return result;
}

interface BrowserSnapshotProjection {
  text: string;
  refs: ReadonlySet<string>;
}

function snapshotProjection(result: BrowserSnapshotResult): BrowserSnapshotProjection {
  const url = result.url;
  const totalElements = result.totalElements;
  const prefix = url ? `${url}\n\n` : '';
  const suffix = takeoverNote(result);
  const candidates = result.elements.slice(0, MAX_BROWSER_SNAPSHOT_ELEMENTS);
  const elementTruncated = candidates.length < totalElements;
  const body = candidates.map(({ text }) => text).join('\n');

  if (
    !elementTruncated &&
    prefix.length + body.length + suffix.length <= MAX_BROWSER_SNAPSHOT_CHARS
  ) {
    return { text: prefix + body + suffix, refs: authorizedSnapshotRefs(candidates) };
  }

  const marker = (shown: number) =>
    `\n\n[browser_snapshot truncated: showing ${shown} of ${totalElements} elements; limits ${MAX_BROWSER_SNAPSHOT_CHARS} characters and ${MAX_BROWSER_SNAPSHOT_ELEMENTS} elements.]`;
  const included: BrowserSnapshotElement[] = [];
  for (const element of candidates) {
    const next = [...included, element];
    const nextBody = next.map(({ text }) => text).join('\n');
    if (
      prefix.length + nextBody.length + marker(next.length).length + suffix.length >
      MAX_BROWSER_SNAPSHOT_CHARS
    ) {
      break;
    }
    included.push(element);
  }
  return {
    text: prefix + included.map(({ text }) => text).join('\n') + marker(included.length) + suffix,
    refs: authorizedSnapshotRefs(included),
  };
}

function authorizedSnapshotRefs(elements: readonly BrowserSnapshotElement[]): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const element of elements) {
    if (element.ref !== undefined) refs.add(element.ref);
  }
  return refs;
}

function extractStart(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) throw new Error('`start` must be a finite number.');
  const normalized = Math.max(0, Math.floor(value));
  if (!Number.isSafeInteger(normalized)) throw new Error('`start` must be a safe integer.');
  return normalized;
}

function waitCondition(input: {
  text?: string;
  selector?: string;
  time?: number;
  timeout?: number;
}): { condition: BrowserWaitCondition; description: string } {
  const conditions = [input.text, input.selector, input.time].filter(
    (value) => value !== undefined,
  );
  if (conditions.length !== 1)
    throw new Error('Provide exactly one of `text`, `selector`, or `time`.');
  for (const [key, value] of [
    ['text', input.text],
    ['selector', input.selector],
  ] as const) {
    if (value !== undefined && value.trim() === '')
      throw new Error(`\`${key}\` must be a non-empty string.`);
  }
  const requested = Math.min(
    input.time ?? input.timeout ?? (input.selector ? 10 : 30),
    MAX_WAIT_SECONDS,
  );
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('`time`/`timeout` must be a positive number of seconds.');
  }
  if (input.text !== undefined) {
    return {
      condition: { kind: 'text', value: input.text, timeoutSeconds: requested },
      description: `text ${JSON.stringify(input.text)}`,
    };
  }
  if (input.selector !== undefined) {
    return {
      condition: { kind: 'selector', value: input.selector, timeoutSeconds: requested },
      description: `selector ${JSON.stringify(input.selector)}`,
    };
  }
  return { condition: { kind: 'time', seconds: requested }, description: `${requested}s pause` };
}

function canonicalWaitArgs(input: {
  text?: string;
  selector?: string;
  time?: number;
  timeout?: number;
}): { text?: string; selector?: string; time?: number; timeout?: number } {
  const { condition } = waitCondition(input);
  switch (condition.kind) {
    case 'text':
      return { text: condition.value, timeout: condition.timeoutSeconds };
    case 'selector':
      return { selector: condition.value, timeout: condition.timeoutSeconds };
    case 'time':
      return { time: condition.seconds };
  }
}

type BrowserBuilderDeps =
  | { backend: BrowserBackend; invocationProvider?: never }
  | { backend?: never; invocationProvider: BrowserBackendInvocationProvider };

export function buildBrowserTools(deps: BrowserBuilderDeps): BrowserToolSet {
  if (Boolean(deps.backend) === Boolean(deps.invocationProvider)) {
    throw new Error('buildBrowserTools requires exactly one backend source');
  }

  interface BrowserTurnState {
    sessionId: string;
    turnId: string;
    affinity?: BrowserBackendAffinity;
    provenanceRevision: number;
    publishedSnapshot?: {
      provenanceRevision: number;
      refs: ReadonlySet<string>;
    };
    nextOrdinal: number;
    tail: Promise<void>;
  }
  interface BrowserReservedExecution extends MakaToolExecutionReservation {
    state: BrowserTurnState;
    provenanceRevision: number;
    ordinal: number;
  }
  type BrowserReservationKind = 'navigate' | 'snapshot' | 'click' | 'type' | 'wait' | 'extract';
  const currentTurnBySession = new Map<string, BrowserTurnState>();
  const reservationsByCall = new Map<string, BrowserReservedExecution>();

  const ensureCurrentTurnState = (identity: BrowserTurnIdentity): BrowserTurnState => {
    const existing = currentTurnBySession.get(identity.sessionId);
    if (existing?.turnId === identity.turnId) return existing;
    const created: BrowserTurnState = {
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      provenanceRevision: 0,
      nextOrdinal: 0,
      // A new Turn drops old provenance/affinity, while preserving Session FIFO
      // ordering if the preceding Turn is still settling.
      tail: existing?.tail ?? Promise.resolve(),
    };
    currentTurnBySession.set(identity.sessionId, created);
    return created;
  };

  function canceledBeforeDispatch(): Error {
    return new Error('Browser action was canceled before backend dispatch.');
  }

  async function waitForTurnSlot(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw canceledBeforeDispatch();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(canceledBeforeDispatch());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void previous.then(() => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(canceledBeforeDispatch());
        else resolve();
      });
    });
  }

  function reservationKey(context: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
  }): string {
    return JSON.stringify([context.sessionId, context.turnId, context.toolCallId]);
  }

  function isSafeAdmissionRecord(value: unknown): value is object {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return false;
      }
    }
    return true;
  }

  function ownEnumerableDataValue(record: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined;
  }

  type RawRefTargetProjection =
    | { kind: 'ref'; value: string }
    | { kind: 'non_ref' }
    | { kind: 'ambiguous' };

  function rawRefTarget(args: unknown): RawRefTargetProjection {
    try {
      if (!isSafeAdmissionRecord(args)) return { kind: 'ambiguous' };
      const target = ownEnumerableDataValue(args, 'target');
      if (typeof target !== 'object' || target === null) return { kind: 'non_ref' };
      if (!isSafeAdmissionRecord(target)) return { kind: 'ambiguous' };
      const kind = ownEnumerableDataValue(target, 'kind');
      const value = ownEnumerableDataValue(target, 'value');
      return kind === 'ref' && typeof value === 'string'
        ? { kind: 'ref', value }
        : { kind: 'non_ref' };
    } catch {
      return { kind: 'ambiguous' };
    }
  }

  function reserveBrowserExecution(
    kind: BrowserReservationKind,
    args: unknown,
    context: Pick<MakaToolContext, 'sessionId' | 'turnId' | 'toolCallId' | 'abortSignal'>,
  ): MakaToolExecutionReservation {
    const targetProjection =
      kind === 'click' || kind === 'type' ? rawRefTarget(args) : ({ kind: 'non_ref' } as const);
    if (targetProjection.kind === 'ambiguous') {
      throw new TypeError(
        'Browser target admission requires plain records with enumerable own data properties.',
      );
    }
    const key = reservationKey(context);
    if (reservationsByCall.has(key)) {
      throw new Error(`Duplicate Browser execution reservation for ${context.toolCallId}.`);
    }
    const state = ensureCurrentTurnState(context);
    const ordinal = state.nextOrdinal;
    state.nextOrdinal += 1;
    if (kind === 'navigate' || kind === 'snapshot') {
      state.provenanceRevision += 1;
      if (kind === 'navigate') state.publishedSnapshot = undefined;
    }
    const provenanceRevision = state.provenanceRevision;
    const refTarget = targetProjection.kind === 'ref' ? targetProjection.value : undefined;
    const capturedSnapshot = refTarget === undefined ? undefined : state.publishedSnapshot;
    const previous = state.tail;
    let finish!: () => void;
    const slot = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.tail = previous.then(() => slot);
    let started = false;
    let settled = false;
    let abortedBeforeRun = false;
    let reservation!: BrowserReservedExecution;
    const abandonQueuedAbort = () => {
      if (!started) {
        abortedBeforeRun = true;
        settle();
      }
    };
    function settle(): void {
      if (settled) return;
      settled = true;
      context.abortSignal.removeEventListener('abort', abandonQueuedAbort);
      if (reservationsByCall.get(key) === reservation) reservationsByCall.delete(key);
      finish();
    }
    reservation = {
      state,
      provenanceRevision,
      ordinal,
      async run<T>(execute: () => Promise<T> | T): Promise<T> {
        if (started || settled) {
          if (abortedBeforeRun) throw canceledBeforeDispatch();
          throw new Error(`Browser execution reservation ${ordinal} is no longer available.`);
        }
        started = true;
        context.abortSignal.removeEventListener('abort', abandonQueuedAbort);
        try {
          await waitForTurnSlot(previous, context.abortSignal);
          if (currentTurnBySession.get(context.sessionId) !== state) {
            throw new Error('Browser Turn state ended before backend dispatch.');
          }
          if (
            refTarget !== undefined &&
            (capturedSnapshot === undefined ||
              capturedSnapshot.provenanceRevision !== provenanceRevision ||
              !capturedSnapshot.refs.has(refTarget))
          ) {
            throw new Error(
              `Browser ref ${refTarget} requires a successful browser_snapshot in the same Turn with that ref visible.`,
            );
          }
          return await execute();
        } finally {
          settle();
        }
      },
      abandon: settle,
    };
    reservationsByCall.set(key, reservation);
    if (context.abortSignal.aborted) abandonQueuedAbort();
    else context.abortSignal.addEventListener('abort', abandonQueuedAbort, { once: true });
    return reservation;
  }

  function requireBrowserReservation(context: MakaToolContext): BrowserReservedExecution {
    const reservation = reservationsByCall.get(reservationKey(context));
    if (!reservation) {
      throw new Error('Browser tool implementation requires a synchronous execution reservation.');
    }
    return reservation;
  }

  function publishSnapshot(
    reservation: BrowserReservedExecution,
    context: MakaToolContext,
    refs: ReadonlySet<string>,
  ): void {
    const { state } = reservation;
    if (
      currentTurnBySession.get(context.sessionId) === state &&
      state.provenanceRevision === reservation.provenanceRevision
    ) {
      state.publishedSnapshot = {
        provenanceRevision: reservation.provenanceRevision,
        refs,
      };
    }
  }

  async function withBackend<T>(
    state: BrowserTurnState,
    context: MakaToolContext,
    run: (
      backend: BrowserBackendOperations,
      browserContext: BrowserInvocationContext,
    ) => Promise<T>,
  ): Promise<T> {
    if (context.abortSignal.aborted) throw canceledBeforeDispatch();
    const browserContext = invocationContext(context);
    const dispatch = async (backend: BrowserBackendOperations) => {
      try {
        return await run(backend, browserContext);
      } catch (error) {
        throw normalizeBrowserBackendError(error) ?? error;
      }
    };
    if (deps.backend) return dispatch(deps.backend);
    if (!browserContext.operationId) {
      throw new Error('Native browser provider requires a durable operationId');
    }
    const acquisition = await deps.invocationProvider.acquire(
      {
        context: browserContext as BrowserInvocationContext & { operationId: string },
        ...(state.affinity !== undefined ? { affinity: state.affinity } : {}),
      },
      context.abortSignal,
    );
    if (context.abortSignal.aborted) {
      if (acquisition.ok) acquisition.invocation.release();
      throw canceledBeforeDispatch();
    }
    if (!acquisition.ok) throw new BrowserBackendError(acquisition.error, acquisition.message);
    if (currentTurnBySession.get(context.sessionId) !== state) {
      acquisition.invocation.release();
      throw new Error('Browser Turn state ended before backend dispatch.');
    }

    if (
      typeof acquisition.invocation.affinity !== 'string' ||
      acquisition.invocation.affinity.length === 0
    ) {
      acquisition.invocation.release();
      throw new BrowserBackendError(
        'service_mismatch',
        'Native browser provider affinity is invalid.',
      );
    }
    if (state.affinity === undefined) {
      state.affinity = acquisition.invocation.affinity;
    } else if (state.affinity !== acquisition.invocation.affinity) {
      acquisition.invocation.release();
      throw new BrowserBackendError(
        'service_mismatch',
        'Native browser provider affinity changed within the Turn.',
      );
    }
    try {
      return await dispatch(acquisition.invocation.backend);
    } finally {
      acquisition.invocation.release();
    }
  }

  /*
   * Browser ordering is reserved above, synchronously at ToolRuntime's execute
   * entrypoint. Implementations below only consume their reservation.
   */

  const navigate: MakaTool<{ url: string }, string> = {
    name: 'browser_navigate',
    displayName: '浏览器导航',
    description:
      "Open a URL in the conversation's embedded browser. Pass a full http:// or https:// URL; other schemes are rejected. " +
      'Returns the URL actually landed on (after redirects) and the page title. Follow with browser_snapshot to see what is on the page.',
    parameters: browserNavigateParameters,
    categoryHint: BROWSER_TOOL_CATEGORY,
    recoveryMode: 'never_auto_retry',
    reserveExecution: (args, context) => reserveBrowserExecution('navigate', args, context),
    prepareIntentArgs: (args) => {
      const { url } = browserNavigateParameters.parse(args);
      const normalized = normalizeBrowserAddressInput(url);
      if (normalized.ok && normalized.url.length > MAX_BROWSER_URL_CHARS) {
        throw new Error(`Normalized Browser URL exceeds ${MAX_BROWSER_URL_CHARS} characters.`);
      }
      return { url: normalized.ok ? normalized.url : url };
    },
    impl: async (args, context) => {
      const { url: rawUrl } = browserNavigateParameters.parse(args);
      const normalized = normalizeBrowserAddressInput(rawUrl);
      if (!normalized.ok) {
        throw new Error(
          `Not a navigable URL: ${JSON.stringify(rawUrl)}. Pass a full http:// or https:// URL.`,
        );
      }
      if (normalized.url.length > MAX_BROWSER_URL_CHARS) {
        throw new Error(`Normalized Browser URL exceeds ${MAX_BROWSER_URL_CHARS} characters.`);
      }
      const { state } = requireBrowserReservation(context);
      const result = validateNavigateResult(
        await withBackend(state, context, (backend, browserContext) =>
          backend.navigate({ url: normalized.url }, context.abortSignal, browserContext),
        ),
      );
      return (
        [`Loaded ${result.url}`, result.title ? `Title: ${result.title}` : undefined]
          .filter(Boolean)
          .join('\n') + takeoverNote(result)
      );
    },
  };

  const snapshot: MakaTool<Record<string, never>, string> = {
    name: 'browser_snapshot',
    displayName: '浏览器快照',
    description:
      'Observe the current page as a list of interactive elements (links, buttons, inputs), each tagged with a `[N]` ' +
      'reference you pass to browser_click / browser_type. This is the primary way to see what is on the page before acting.',
    parameters: z.object({}).strict(),
    categoryHint: BROWSER_TOOL_CATEGORY,
    recoveryMode: 'never_auto_retry',
    reserveExecution: (args, context) => reserveBrowserExecution('snapshot', args, context),
    impl: async (_args, context) => {
      const reservation = requireBrowserReservation(context);
      const result = validateSnapshotResult(
        await withBackend(reservation.state, context, (backend, browserContext) =>
          backend.snapshot(context.abortSignal, browserContext),
        ),
      );
      const projection = snapshotProjection(result);
      publishSnapshot(reservation, context, projection.refs);
      return projection.text;
    },
  };

  const click: MakaTool<{ target: BrowserTarget }, string> = {
    name: 'browser_click',
    displayName: '浏览器点击',
    description:
      'Click an element using an explicit browser_snapshot ref target (like `{ kind: "ref", value: "[12]" }`) or CSS selector target. ' +
      'Reports how many elements matched and the match confidence; re-snapshot if multiple matched.',
    parameters: z.object({ target: browserTargetSchema }).strict(),
    categoryHint: BROWSER_TOOL_CATEGORY,
    recoveryMode: 'never_auto_retry',
    reserveExecution: (args, context) => reserveBrowserExecution('click', args, context),
    prepareIntentArgs: ({ target }) => ({ target: browserTargetSchema.parse(target) }),
    impl: async ({ target: rawTarget }, context) => {
      const target = browserTargetSchema.parse(rawTarget) as BrowserTarget;
      const { state } = requireBrowserReservation(context);
      const result = validateClickResult(
        await withBackend(state, context, (backend, browserContext) =>
          backend.click({ target }, context.abortSignal, browserContext),
        ),
      );
      return (
        `Clicked ${target.value} (matched ${result.matches} element${result.matches === 1 ? '' : 's'}, ${result.matchLevel} match).` +
        (result.matches > 1
          ? ' Multiple matches — verify the right element reacted, or re-snapshot for a tighter ref.'
          : '') +
        takeoverNote(result)
      );
    },
  };

  const type: MakaTool<{ target: BrowserTarget; text: string; submit?: boolean }, string> = {
    name: 'browser_type',
    displayName: '浏览器输入',
    description:
      'Fill text into a field using an explicit browser_snapshot ref target (like `{ kind: "ref", value: "[7]" }`) or CSS selector target; replaces the current content. ' +
      'Set submit=true to press Enter after. Self-verifies the field now holds the requested text.',
    parameters: browserTypeParameters,
    categoryHint: BROWSER_TOOL_CATEGORY,
    recoveryMode: 'never_auto_retry',
    reserveExecution: (args, context) => reserveBrowserExecution('type', args, context),
    prepareIntentArgs: (args) => {
      const { target, text, submit = false } = browserTypeParameters.parse(args);
      return { target, text, submit };
    },
    impl: async (args, context) => {
      const {
        target,
        text,
        submit = false,
      } = browserTypeParameters.parse(args) as {
        target: BrowserTarget;
        text: string;
        submit?: boolean;
      };
      const { state } = requireBrowserReservation(context);
      const result = validateTypeResult(
        await withBackend(state, context, (backend, browserContext) =>
          backend.type({ target, text, submit }, context.abortSignal, browserContext),
        ),
      );
      const lines = [
        `Filled ${target.value} (${result.matchLevel} match)${submit ? ', then pressed Enter' : ''}.`,
        result.verified
          ? 'Verified: the field contains the requested text.'
          : `Not verified — the field now contains: ${JSON.stringify(result.actual)}`,
      ];
      return lines.join('\n') + takeoverNote(result);
    },
  };

  const wait: MakaTool<
    { text?: string; selector?: string; time?: number; timeout?: number },
    string
  > = {
    name: 'browser_wait',
    displayName: '浏览器等待',
    description:
      'Wait for the page to be ready: until `text` is visible, until a CSS `selector` matches, or a fixed `time` pause in seconds. ' +
      'Provide exactly one of text / selector / time. Prefer text or selector over a blind pause.',
    parameters: browserWaitParameters,
    categoryHint: BROWSER_TOOL_CATEGORY,
    recoveryMode: 'never_auto_retry',
    reserveExecution: (args, context) => reserveBrowserExecution('wait', args, context),
    prepareIntentArgs: (args) => canonicalWaitArgs(browserWaitParameters.parse(args)),
    impl: async (args, context) => {
      const { condition, description } = waitCondition(browserWaitParameters.parse(args));
      const { state } = requireBrowserReservation(context);
      const info = validateWaitResult(
        await withBackend(state, context, (backend, browserContext) =>
          backend.wait({ condition }, context.abortSignal, browserContext),
        ),
      );
      return `Done: ${description}.` + takeoverNote(info);
    },
  };

  const extract: MakaTool<{ selector?: string; start?: number }, string> = {
    name: 'browser_extract',
    displayName: '浏览器提取',
    description:
      'Read the page (or a CSS-selected region) as Markdown for analysis. Omit selector for the whole body. ' +
      'Long pages page through `start` — the output names the next_start_char to continue from.',
    parameters: browserExtractParameters,
    categoryHint: BROWSER_TOOL_CATEGORY,
    recoveryMode: 'never_auto_retry',
    reserveExecution: (args, context) => reserveBrowserExecution('extract', args, context),
    prepareIntentArgs: (args) => {
      const { selector, start } = browserExtractParameters.parse(args);
      return {
        ...(selector !== undefined ? { selector } : {}),
        start: extractStart(start),
      };
    },
    impl: async (args, context) => {
      const { selector, start: rawStart } = browserExtractParameters.parse(args);
      const start = extractStart(rawStart);
      const { state } = requireBrowserReservation(context);
      const request = {
        ...(selector === undefined ? {} : { selector }),
        start,
        limit: EXTRACT_CHAR_LIMIT,
      };
      const result = validateExtractResult(
        await withBackend(state, context, (backend, browserContext) =>
          backend.extract(request, context.abortSignal, browserContext),
        ),
        request,
      );
      if (result.chunk === null) {
        throw new Error(
          selector
            ? `No element matches selector ${JSON.stringify(selector)}.`
            : 'The page has no readable body yet — navigate somewhere first.',
        );
      }
      return (
        (result.url ? `${result.url}\n\n` : '') +
        result.chunk +
        (result.hasMore
          ? `\n\n(Content continues — call browser_extract again with start=${result.nextStart}. next_start_char: ${result.nextStart})`
          : '') +
        (result.sourceTruncated
          ? "\n\n(The page's HTML was larger than the extraction ceiling; trailing content was dropped before conversion. Use `selector` to target the part you need.)"
          : '') +
        takeoverNote(result)
      );
    },
  };

  const tools = [navigate, snapshot, click, type, wait, extract] as BrowserToolSet;
  tools.releaseTurnState = (input): Promise<void> => {
    if (currentTurnBySession.get(input.sessionId)?.turnId === input.turnId) {
      currentTurnBySession.delete(input.sessionId);
    }
    for (const reservation of [...reservationsByCall.values()]) {
      if (
        reservation.state.sessionId === input.sessionId &&
        reservation.state.turnId === input.turnId
      ) {
        reservation.abandon();
      }
    }
    return deps.backend ? deps.backend.releaseTurnState(input) : Promise.resolve();
  };
  return tools;
}
