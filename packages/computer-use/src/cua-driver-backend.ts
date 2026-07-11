// PR-RUNTIME-CU — the cua-driver CuDispatchBackend (Tier-2 alternative to the
// public-API Swift helper). Spawns trycua/cua-driver (MIT, v0.7.1) in EMBEDDED
// mode and speaks its line-delimited JSON-RPC 2.0 over stdio.
//
// Why embedded + direct spawn: cua-driver's embedded mode inherits the host
// app's TCC grants via the macOS responsibility chain (no second Accessibility/
// Screen-Recording prompt) — but ONLY if we spawn it as a DIRECT child of the
// process that holds the grants (never via `open`/LaunchServices).
//
// Path 18 note: this module only marshals CuAction ↔ cua-driver JSON-RPC and
// neutralizes cua-driver's baggage (telemetry/updater/autostart/overlay off).
// The OS-independent Path 18 duties (per-action TCC re-check, typed errors,
// abort) stay in the @maka/runtime `computer` tool. cua-driver does NOT redact
// secrets — the runtime redacts every backend-supplied message upstream.
//
// KEYBOARD IS TARGET-BOUND, VERIFIED, AND NEVER FRONTMOST. A successful left
// click establishes ownership only for the same Maka session + turn. `type` is
// allowed only for a native, AX-addressable empty field: Maka writes AXValue and
// confirms the value in a fresh snapshot. Electron/unknown processes, non-empty
// fields, and every `key` action fail before any key event is posted. Scroll,
// drag, failed clicks, another session, and another turn never establish ownership.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type CuAction,
  exceedsComputerUseFrameCap,
} from '@maka/core';
import type { CuDispatchBackend, CuRunContext, CuRunResult, CuScreenshot } from '@maka/runtime';
import { normalizeCuaDriverOutcome } from './cua-driver-result.js';
import {
  CUA_INSPECT_PREPARED_ELEMENT_SCRIPT,
  buildCuaPrepareElementAtScreenPointScript,
  buildCuaSemanticPointerActionScript,
  parseCuaFocusedPageElement,
  parseCuaSemanticPointerResult,
  resolveCuaPageTextTarget,
  type CuaSemanticPointerAction,
  type CuaSemanticPointerResult,
  type CuaResolvedPageTextTarget,
} from './cua-driver-page-target.js';
import {
  editableElementAtScreenPoint,
  elementAtScreenPoint,
  resolveWindowAtDeclaredPoint,
  windowPointFromSnapshot,
  type CuaResolvedWindow,
  type CuaSnapshotElement,
} from './cua-driver-snapshot.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Defensive transport bound. A legitimate frame is a single multi-MB base64
// line (~2.7MB for the 2MB-capped PNG); an order of magnitude beyond that is a
// runaway/garbage stream, so we tear down instead of growing memory unbounded.
const MAX_STDOUT_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL_CAP = 4096;
// Frames larger than this get compressed (to JPEG) before the cap check. Small
// crisp PNGs (simple screens) pass through untouched.
const COMPRESS_FRAME_THRESHOLD = 1.5 * 1024 * 1024;

export interface CuaDriverBackendOptions {
  /** Absolute path to the bundled `cua-driver` binary. */
  binaryPath: string;
  /** The host app's bundle id, for TCC responsibility-chain inheritance. */
  hostBundleId: string;
  timeoutMs?: number;
  /** Per-request bound on the startup handshake (defaults to HANDSHAKE_TIMEOUT_MS). */
  handshakeTimeoutMs?: number;
  /**
   * Optional frame compressor: given a captured frame (base64 + mimeType) returns
   * a smaller encoding at the SAME (native) resolution — so coordinates are
   * unchanged. Applied only to large frames. Runs in Electron main (nativeImage);
   * omitted under node --test, where frames pass through untouched.
   */
  compressFrame?: (base64: string, mimeType: string) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  /** Test seam; production classifies the target executable before any keyboard action. */
  classifyProcess?: (pid: number) => Promise<'electron' | 'native' | 'unknown'>;
  /** Test seam; production resolves only already-listening, uniquely identified CDP pages. */
  resolvePageTextTarget?: (input: {
    pid: number;
    windowTitle?: string;
    signal: AbortSignal;
  }) => Promise<CuaResolvedPageTextTarget | undefined>;
  /** Privacy-safe diagnostic stream: geometry, roles, dispatch path, and outcome only. */
  onTrace?: (event: CuaDriverTraceEvent) => void;
}

export type CuaDriverTraceEvent =
  | {
      type: 'target';
      toolCallId?: string;
      actionType: CuAction['type'];
      pid: number;
      windowId: number;
      title?: string;
      screenPoint: { x: number; y: number };
    }
  | {
      type: 'snapshot';
      toolCallId?: string;
      actionType: CuAction['type'];
      pid: number;
      windowId: number;
      windowPoint: { x: number; y: number };
      containingElements: Array<{
        elementIndex: number;
        role: string;
        depth: number;
        frame: { x: number; y: number; w: number; h: number };
      }>;
      editableElementIndex?: number;
      clickableElementIndex?: number;
    }
  | {
      type: 'dispatch';
      toolCallId?: string;
      actionType: CuAction['type'];
      tool: string;
      pid?: number;
      windowId?: number;
      address: 'ax' | 'px' | 'semantic' | 'none';
    }
  | {
      type: 'outcome';
      toolCallId?: string;
      actionType: CuAction['type'];
      tool: string;
      outcome: CuRunResult['outcome'];
    }
  | {
      type: 'semantic_result';
      toolCallId?: string;
      actionType: CuAction['type'];
      pid: number;
      windowId: number;
      port: number;
      supported: boolean;
      ok: boolean;
      reason?: string;
      effect?: string;
      tagName?: string;
      inputType?: string;
    }
  | {
      type: 'fallback';
      toolCallId?: string;
      actionType: CuAction['type'];
      from: 'semantic';
      to: 'pixel';
      reason: string;
    };

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
  error?: { code: number; message: string };
}

interface CuaDriverClientOptions extends CuaDriverBackendOptions {
  captureScope: 'window' | 'desktop';
  homeDir: string;
}

interface PendingRequest {
  resolve: (r: JsonRpcResponse) => void;
  reject: (e: Error) => void;
}

/** Line-delimited JSON-RPC 2.0 client over a long-lived cua-driver child. */
class CuaDriverClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private starting?: Promise<void>;
  private disposed = false;

  constructor(private readonly opts: CuaDriverClientOptions) {}

  private assertActive(): void {
    if (this.disposed) throw new Error('cua-driver client disposed');
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (!this.starting) {
      if (this.child && !this.child.killed) return;
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    const startResult = this.starting;
    if (!signal) return startResult;
    // Honor an abort that arrives while an in-flight startup is still handshaking
    // (start() is separately bounded by HANDSHAKE_TIMEOUT_MS as the backstop).
    return Promise.race([
      startResult,
      new Promise<void>((_, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
  }

  private async start(): Promise<void> {
    this.assertActive();
    // Neutralize cua-driver's install-ping (the one telemetry event its env
    // opt-out does NOT stop) by pre-seeding its marker file. Best-effort.
    try {
      const dir = join(this.opts.homeDir, '.cua-driver');
      await mkdir(dir, { recursive: true });
      this.assertActive();
      await writeFile(join(dir, '.installation_recorded'), '1', { flag: 'wx' });
      this.assertActive();
    } catch {
      this.assertActive();
      // Marker creation is non-fatal. The isolated HOME still prevents writes
      // to the user's cua-driver configuration.
    }

    this.assertActive();
    const child = spawn(this.opts.binaryPath, ['mcp', '--embedded', '--no-daemon-relaunch', '--no-overlay', '--host-bundle-id', this.opts.hostBundleId], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: this.opts.homeDir,
        CUA_DRIVER_EMBEDDED: '1',
        CUA_DRIVER_HOST_BUNDLE_ID: this.opts.hostBundleId,
        CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
        CUA_DRIVER_RS_UPDATE_CHECK: 'false',
        // Maka draws its OWN agent cursor overlay, so cua-driver's must never
        // render (else the user sees TWO cursors). --no-overlay is the definitive
        // disable ("Disable the cursor overlay entirely"); --no-daemon-relaunch
        // keeps it in-process. (--no-daemon-relaunch alone did NOT suppress it.)
        CUA_DRIVER_RS_MCP_NO_RELAUNCH: '1',
      },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(child, chunk));
    // Drain stderr into a bounded tail. An undrained piped stderr fills its OS
    // pipe buffer (~64KB), blocks the child's writes, and wedges all RPC.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(child, chunk));
    // An EPIPE/ERR_STREAM_DESTROYED during the child's crash window is emitted
    // as a stdin 'error' event; unhandled it crashes the Electron main process.
    // Route it into the orderly teardown instead.
    child.stdin.on('error', () => this.onExit(child));
    child.on('exit', () => this.onExit(child));
    child.on('error', () => this.onExit(child));

    // Bounded, fail-closed handshake. A spawned-but-silent child must not
    // deadlock every future action: each awaited request is timeout-guarded,
    // and ANY handshake failure kills the child so the next call retries fresh.
    const handshakeTimeoutMs = this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    try {
      await this.request(
        'initialize',
        { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'maka', version: '0.1' } },
        { timeoutMs: handshakeTimeoutMs },
      );
      this.assertActive();
      // `session` is deliberately never opened → no cursor overlay.
      this.notify('notifications/initialized');
      // Each client owns an isolated HOME, so set_config cannot mutate the
      // user's global ~/.cua-driver/config.json or another client role.
      // Fail CLOSED: if set_config errors, reject start() rather than warn-and-
      // continue against an unconfigured scope while reporting ok.
      const cfg = await this.request(
        'tools/call',
        { name: 'set_config', arguments: { capture_scope: this.opts.captureScope } },
        { timeoutMs: handshakeTimeoutMs },
      );
      this.assertActive();
      if (cfg.error) throw new Error(`set_config capture_scope=${this.opts.captureScope} failed: ${cfg.error.message}`);
    } catch (e) {
      this.kill();
      throw e;
    }
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER) {
      // Runaway/garbage stream with no line terminator — tear down (fail closed).
      this.kill();
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // ignore non-JSON log noise
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (p) p.resolve(msg); // resolve() runs cleanup(), which deletes the entry
      }
      // notifications (no id) are ignored
    }
  }

  private onStderr(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CAP);
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    const err = new Error('cua-driver exited');
    // Snapshot + clear BEFORE rejecting: each reject runs cleanup() which
    // deletes from `pending`, and mutating the map mid-iteration is unsafe.
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const p of entries) p.reject(err);
    this.child = undefined;
    this.buffer = '';
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      /* child gone mid-notify — the stdin 'error'/exit handler drives recovery */
    }
  }

  /**
   * Send one JSON-RPC request. Every request is bounded: an optional timeout and
   * AbortSignal each reject the promise and remove its pending entry (no timer or
   * listener leak). This is what makes both actions AND the startup handshake
   * un-hangable.
   */
  private request(method: string, params: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const child = this.child;
      if (!child || child.killed) {
        reject(new Error('cua-driver not running'));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && opts?.signal) opts.signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const entry: PendingRequest = {
        resolve: (r) => { cleanup(); resolve(r); },
        reject: (e) => { cleanup(); reject(e); },
      };
      this.pending.set(id, entry);
      if (opts?.signal) {
        if (opts.signal.aborted) { entry.reject(new Error('aborted')); return; }
        onAbort = () => entry.reject(new Error('aborted'));
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (opts?.timeoutMs) {
        timer = setTimeout(() => entry.reject(new Error('timeout')), opts.timeoutMs);
      }
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        entry.reject(e as Error);
      }
    });
  }

  /** Invoke a cua-driver tool; returns the JSON-RPC result payload. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonRpcResponse['result']> {
    this.assertActive();
    await this.ensureStarted(signal);
    this.assertActive();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const res = await this.request('tools/call', { name, arguments: args }, { timeoutMs, signal });
      if (res.error) throw new Error(`cua-driver ${name}: ${res.error.message}`);
      return res.result;
    } catch (e) {
      // Only kill on timeout/abort (an in-flight action can't be cancelled
      // in-band); a plain JSON-RPC error or a child-exit rejection must not.
      const m = (e as Error).message;
      if (m === 'timeout' || m === 'aborted') this.kill();
      throw e;
    }
  }

  kill(): void {
    const child = this.child;
    if (!child) return;
    child.kill('SIGKILL');
    this.onExit(child);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const starting = this.starting;
    this.kill();
    const removeHome = () => rmSync(this.opts.homeDir, { recursive: true, force: true });
    removeHome();
    void starting?.then(removeHome, removeHome);
  }
}

async function classifyMacProcess(pid: number): Promise<'electron' | 'native' | 'unknown'> {
  const executable = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  }).catch(() => '');
  if (!executable.startsWith('/')) return 'unknown';
  const contentsDir = dirname(dirname(executable));
  const electronFramework = join(contentsDir, 'Frameworks', 'Electron Framework.framework');
  try {
    await access(electronFramework);
    return 'electron';
  } catch {
    return 'native';
  }
}

export function createCuaDriverBackend(opts: CuaDriverBackendOptions): CuDispatchBackend & {
  inspectWindowAt: (
    point: { x: number; y: number },
    signal: AbortSignal,
  ) => Promise<CuaResolvedWindow | undefined>;
  clearSession: (sessionId: string) => void;
  dispose: () => void;
} {
  const clientHome = (role: 'action' | 'capture') =>
    join(tmpdir(), `maka-cua-${role}-${process.pid}-${randomUUID()}`);
  const actionClient = new CuaDriverClient({
    ...opts,
    captureScope: 'window',
    homeDir: clientHome('action'),
  });
  const captureClient = new CuaDriverClient({
    ...opts,
    captureScope: 'desktop',
    homeDir: clientHome('capture'),
  });
  // Cached backing scale (device px per logical point). The model's click
  // coordinate is in get_desktop_state DEVICE pixels; window bounds from
  // list_windows are in logical SCREEN POINTS, so we convert with this.
  let lastFrameWidthPx: number | undefined; // device width of the last capture

  // Keyboard ownership is session + turn scoped. Only a successful click may
  // establish it; pointer-only scroll/drag actions do not imply text focus.
  interface KeyboardTarget {
    window: CuaResolvedWindow;
    editable: boolean;
    pageTarget?: CuaResolvedPageTextTarget;
  }
  const targetsBySession = new Map<string, { turnId: string; target: KeyboardTarget }>();
  const sessionGenerations = new Map<string, number>();
  let operationQueue = Promise.resolve();
  let disposed = false;

  function trace(event: CuaDriverTraceEvent): void {
    try {
      opts.onTrace?.(event);
    } catch {
      // Diagnostics must never change dispatch.
    }
  }

  async function displayMetrics(signal: AbortSignal): Promise<{
    desktopFrameWidthPx: number;
    logicalDisplayWidth: number;
  }> {
    const r = await actionClient.callTool('get_screen_size', {}, signal);
    const sc = r?.structuredContent ?? {};
    const logicalW = typeof sc.width === 'number' && sc.width > 0 ? sc.width : 0;
    const fallbackScale = typeof sc.scale_factor === 'number' && sc.scale_factor > 0 ? sc.scale_factor : 1;
    return {
      desktopFrameWidthPx: lastFrameWidthPx ?? logicalW * fallbackScale,
      logicalDisplayWidth: logicalW,
    };
  }

  async function withOperationQueue<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (disposed) throw new Error('cua-driver backend disposed');
    const previous = operationQueue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    operationQueue = current;
    await previous;
    try {
      if (disposed) throw new Error('cua-driver backend disposed');
      if (signal.aborted) throw new Error('aborted');
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Resolve the frontmost on-screen app window under a DEVICE-pixel click point,
   * mirroring cua-driver's own scope:'desktop' resolution (screen-point space,
   * layer-0, highest z_index wins). Returns the target pid + window_id + the
   * window-local DEVICE coordinate. Null when NO app window owns the pixel (empty
   * desktop) — where cua-driver would warp the real cursor, so we must refuse.
   * Excludes non-layer-0 windows, which also excludes Maka's always-on-top overlay.
   */
  async function resolveWindowAt(
    deviceX: number,
    deviceY: number,
    signal: AbortSignal,
  ): Promise<CuaResolvedWindow | undefined> {
    const metrics = await displayMetrics(signal);
    const r = await actionClient.callTool('list_windows', {}, signal);
    return resolveWindowAtDeclaredPoint({
      declaredPoint: { x: deviceX, y: deviceY },
      desktopFrameWidthPx: metrics.desktopFrameWidthPx,
      logicalDisplayWidth: metrics.logicalDisplayWidth,
      windows: (r?.structuredContent?.windows ?? []) as Array<Record<string, unknown>>,
    });
  }

  interface TargetSnapshot {
    elements: CuaSnapshotElement[];
    screenshotWidthPx: number;
    screenshotHeightPx: number;
    windowPoint: { x: number; y: number };
  }

  async function snapshotTarget(
    target: CuaResolvedWindow,
    signal: AbortSignal,
  ): Promise<TargetSnapshot> {
    const state = await actionClient.callTool(
      'get_window_state',
      {
        pid: target.pid,
        window_id: target.windowId,
        include_screenshot: true,
        max_elements: 500,
        max_depth: 25,
      },
      signal,
    );
    const outcome = normalizeCuaDriverOutcome(state);
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    const structured = state?.structuredContent ?? {};
    const windowPoint = windowPointFromSnapshot({
      screenPoint: target.screenPoint,
      windowBounds: target.bounds,
      screenshotWidthPx: Number(structured.screenshot_width),
      screenshotHeightPx: Number(structured.screenshot_height),
    });
    if (!windowPoint) {
      throw new Error('cua-driver returned invalid window screenshot dimensions');
    }
    return {
      elements: (structured.elements ?? []) as CuaSnapshotElement[],
      screenshotWidthPx: Number(structured.screenshot_width),
      screenshotHeightPx: Number(structured.screenshot_height),
      windowPoint,
    };
  }

  function targetForContext(context: CuRunContext): KeyboardTarget | undefined {
    const state = targetsBySession.get(context.sessionId);
    if (!state) return undefined;
    if (state.turnId !== context.turnId) {
      targetsBySession.delete(context.sessionId);
      return undefined;
    }
    return state.target;
  }

  async function fillEditableTarget(
    target: KeyboardTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<CuRunResult['outcome']> {
    const processKind = await (opts.classifyProcess ?? classifyMacProcess)(target.window.pid);
    if (processKind === 'electron') {
      return fillElectronPageTarget(target, text, signal);
    }
    if (processKind !== 'native') {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'target process type could not be verified; background key events are refused',
      };
    }
    if (!target.editable) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background text input requires an AX-addressable editable field',
      };
    }
    const snapshot = await snapshotTarget(target.window, signal);
    const element = editableElementAtScreenPoint(snapshot.elements, target.window.screenPoint);
    if (!element) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'editable field was not present in the fresh AX snapshot',
      };
    }
    if (element.value && element.value !== text) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background AX fill refuses to overwrite a non-empty field',
      };
    }
    if (element.value === text) {
      return {
        ok: true,
        tier: 'ax',
        verified: true,
        evidence: { path: 'ax', effect: 'confirmed' },
      };
    }
    const setResult = await actionClient.callTool(
      'set_value',
      {
        pid: target.window.pid,
        window_id: target.window.windowId,
        element_index: element.element_index,
        ...(element.element_token ? { element_token: element.element_token } : {}),
        value: text,
      },
      signal,
    );
    if (setResult?.isError) return normalizeCuaDriverOutcome(setResult);
    const after = await snapshotTarget(target.window, signal);
    const verified = editableElementAtScreenPoint(
      after.elements,
      target.window.screenPoint,
    )?.value === text;
    return verified
      ? {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: { path: 'ax', effect: 'confirmed' },
        }
      : {
          ok: false,
          error: 'capture_failed',
          message: 'AXValue write could not be confirmed by a fresh snapshot',
          evidence: { path: 'ax', effect: 'unverifiable' },
        };
  }

  async function fillElectronPageTarget(
    target: KeyboardTarget,
    text: string,
    signal: AbortSignal,
  ): Promise<CuRunResult['outcome']> {
    if (!target.editable) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background Electron text requires a verified text-editable click target',
      };
    }
    const pageTarget = target.pageTarget ?? await (
      opts.resolvePageTextTarget ?? ((input) => resolveCuaPageTextTarget(input))
    )({
      pid: target.window.pid,
      ...(target.window.title ? { windowTitle: target.window.title } : {}),
      signal,
    });
    if (!pageTarget) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'Electron background text requires a unique, already-listening CDP page target',
      };
    }
    const executePageScript = async (javascript: string) => {
      const response = await actionClient.callTool(
        'page',
        {
          pid: target.window.pid,
          window_id: target.window.windowId,
          action: 'execute_javascript',
          javascript,
          cdp_port: pageTarget.port,
          target_url_contains: pageTarget.targetUrlContains,
        },
        signal,
      );
      if (response?.isError) return { response };
      const text = response?.content?.find(
        (content) => content.type === 'text' && typeof content.text === 'string',
      )?.text;
      return { response, element: parseCuaFocusedPageElement(text) };
    };
    const prepared = await executePageScript(
      buildCuaPrepareElementAtScreenPointScript(target.window.screenPoint),
    );
    if (prepared.response?.isError) return normalizeCuaDriverOutcome(prepared.response);
    const before = prepared.element;
    if (!before?.editable) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'the uniquely identified Electron page has no focused editable DOM element',
      };
    }
    if (before.value && before.value !== text) {
      return {
        ok: false,
        error: 'unsupported_action',
        message: 'background Electron fill refuses to overwrite a non-empty DOM field',
      };
    }
    if (before.value === text) {
      return {
        ok: true,
        tier: 'semantic-background',
        verified: true,
        evidence: { path: 'cdp', effect: 'confirmed' },
      };
    }
    const result = await actionClient.callTool(
      'page',
      {
        pid: target.window.pid,
        window_id: target.window.windowId,
        action: 'insert_text',
        text,
        cdp_port: pageTarget.port,
        target_url_contains: pageTarget.targetUrlContains,
      },
      signal,
    );
    if (result?.isError) return normalizeCuaDriverOutcome(result);
    const inspected = await executePageScript(CUA_INSPECT_PREPARED_ELEMENT_SCRIPT);
    if (inspected.response?.isError) return normalizeCuaDriverOutcome(inspected.response);
    const after = inspected.element;
    return after?.editable === true && after.value === text
      ? {
          ok: true,
          tier: 'semantic-background',
          verified: true,
          evidence: { path: 'cdp', effect: 'confirmed' },
        }
      : {
          ok: false,
          error: 'capture_failed',
          message: 'CDP Input.insertText could not be confirmed by DOM readback',
          evidence: { path: 'cdp', effect: 'unverifiable' },
        };
  }

  async function runElectronSemanticPointer(
    action: CuaSemanticPointerAction,
    window: CuaResolvedWindow,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<{
    handled: boolean;
    outcome?: CuRunResult['outcome'];
    result?: CuaSemanticPointerResult;
    pageTarget?: CuaResolvedPageTextTarget;
  }> {
    const processKind = await (opts.classifyProcess ?? classifyMacProcess)(window.pid);
    if (processKind !== 'electron') return { handled: false };
    const resolvePageTextTarget = opts.resolvePageTextTarget ?? ((input) =>
      resolveCuaPageTextTarget(input));
    const pageTarget = await resolvePageTextTarget({
      pid: window.pid,
      ...(window.title ? { windowTitle: window.title } : {}),
      signal,
    });
    if (!pageTarget) {
      trace({
        type: 'fallback',
        toolCallId,
        actionType: action.type,
        from: 'semantic',
        to: 'pixel',
        reason: 'page_target_unavailable',
      });
      return { handled: false };
    }

    trace({
      type: 'dispatch',
      toolCallId,
      actionType: action.type,
      tool: 'page',
      pid: window.pid,
      windowId: window.windowId,
      address: 'semantic',
    });
    const response = await actionClient.callTool(
      'page',
      {
        pid: window.pid,
        window_id: window.windowId,
        action: 'execute_javascript',
        javascript: buildCuaSemanticPointerActionScript(action),
        cdp_port: pageTarget.port,
        target_url_contains: pageTarget.targetUrlContains,
      },
      signal,
    );
    if (response?.isError) {
      const outcome = normalizeCuaDriverOutcome(response);
      trace({ type: 'outcome', toolCallId, actionType: action.type, tool: 'page', outcome });
      return { handled: true, outcome };
    }
    const text = response?.content?.find(
      (content) => content.type === 'text' && typeof content.text === 'string',
    )?.text;
    const result = parseCuaSemanticPointerResult(text);
    if (!result) {
      const outcome: CuRunResult['outcome'] = {
        ok: false,
        error: 'capture_failed',
        message: 'cua-driver page action returned an invalid semantic result',
        evidence: { path: 'cdp', effect: 'unverifiable' },
      };
      trace({ type: 'outcome', toolCallId, actionType: action.type, tool: 'page', outcome });
      return { handled: true, outcome };
    }
    trace({
      type: 'semantic_result',
      toolCallId,
      actionType: action.type,
      pid: window.pid,
      windowId: window.windowId,
      port: pageTarget.port,
      supported: result.supported,
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.effect ? { effect: result.effect } : {}),
      ...(result.tagName ? { tagName: result.tagName } : {}),
      ...(result.inputType ? { inputType: result.inputType } : {}),
    });
    if (!result.supported) {
      trace({
        type: 'fallback',
        toolCallId,
        actionType: action.type,
        from: 'semantic',
        to: 'pixel',
        reason: result.reason ?? 'unsupported_action',
      });
      return { handled: false, result };
    }
    const outcome: CuRunResult['outcome'] = result.ok
      ? {
          ok: true,
          tier: 'semantic-background',
          verified: true,
          evidence: { path: 'cdp', effect: 'confirmed' },
        }
      : {
          ok: false,
          error: 'capture_failed',
          message: `semantic pointer action did not verify (${result.reason ?? result.kind ?? action.type})`,
          evidence: { path: 'cdp', effect: 'unverifiable' },
        };
    trace({ type: 'outcome', toolCallId, actionType: action.type, tool: 'page', outcome });
    return { handled: true, outcome, result, pageTarget };
  }

  return {
    async inspectWindowAt(point, signal) {
      return withOperationQueue(
        signal,
        () => resolveWindowAt(point.x, point.y, signal),
      );
    },

    async preflight(signal) {
      return withOperationQueue(signal, async () => {
        const r = await actionClient.callTool('check_permissions', { prompt: false }, signal);
        const sc = r?.structuredContent ?? {};
        return {
          accessibility: sc.accessibility === true,
          // Prefer the live ScreenCaptureKit probe over the cached boolean.
          screenRecording: sc.screen_recording_capturable === true || sc.screen_recording === true,
        };
      });
    },

    async run(action, signal, context: CuRunContext): Promise<CuRunResult> {
      const sessionGeneration = sessionGenerations.get(context.sessionId) ?? 0;
      return withOperationQueue(signal, async () => {
        // A new turn invalidates any prior keyboard ownership before this action.
        targetForContext(context);
        // A left-click attempt transfers ownership. Clear the old target before
        // resolution/snapshot/dispatch so any failure leaves keyboard input
        // unowned instead of silently routing it to the previous window.
        if (action.type === 'left_click') targetsBySession.delete(context.sessionId);
        switch (action.type) {
        case 'screenshot': {
          const r = await captureClient.callTool('get_desktop_state', {}, signal);
          const img = r?.content?.find((c) => c.type === 'image');
          if (!img?.data) return { outcome: { ok: false, error: 'capture_failed', message: 'no image returned' } };
          let base64 = img.data;
          let mimeType: 'image/png' | 'image/jpeg' = img.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          let byteLength = Buffer.from(base64, 'base64').byteLength;
          // Compress large frames (native res, coords unchanged) so a Retina
          // full-display PNG doesn't balloon past the cap / the provider's limit.
          if (opts.compressFrame && byteLength > COMPRESS_FRAME_THRESHOLD) {
            const c = opts.compressFrame(base64, mimeType);
            base64 = c.base64;
            mimeType = c.mimeType;
            byteLength = Buffer.from(base64, 'base64').byteLength;
          }
          if (exceedsComputerUseFrameCap(byteLength)) {
            return { outcome: { ok: false, error: 'sensitivity_blocked', message: `frame ${byteLength}B exceeds cap` } };
          }
          const sc = r?.structuredContent ?? {};
          // Remember the device frame width so getScale() can derive the true
          // device/logical ratio (see getScale — scale_factor is unreliable).
          if (typeof sc.screenshot_width === 'number' && sc.screenshot_width > 0) {
            lastFrameWidthPx = sc.screenshot_width;
          }
          const screenshot: CuScreenshot = {
            base64,
            mimeType,
            widthPx: typeof sc.screenshot_width === 'number' ? sc.screenshot_width : 0,
            heightPx: typeof sc.screenshot_height === 'number' ? sc.screenshot_height : 0,
          };
          return { outcome: { ok: true, tier: 'coordinate-background' }, screenshot };
        }
        case 'left_click':
        case 'right_click':
        case 'middle_click':
        case 'double_click':
        case 'triple_click': {
          // Resolve the window under the point and click via pid+window_id, which
          // forces cua-driver's click_at_xy_with_window_local → CGEventPostToPid /
          // SLEventPostToPid — NO cursor warp (unlike windowless scope:'desktop',
          // which CGWarpMouseCursorPositions the REAL cursor). Fail closed when no
          // app window owns the pixel (empty desktop), where the only path warps.
          const win = await resolveWindowAt(action.coordinate.x, action.coordinate.y, signal);
          if (!win) {
            return {
              outcome: {
                ok: false,
                error: 'unsupported_action',
                message:
                  `no app window under the click point (empty desktop / wallpaper) — refusing '${action.type}': `
                  + "the only backend path there warps the user's real cursor. Click on an app window instead.",
              },
            };
          }
          trace({
            type: 'target',
            toolCallId: context.toolCallId,
            actionType: action.type,
            pid: win.pid,
            windowId: win.windowId,
            ...(win.title ? { title: win.title } : {}),
            screenPoint: win.screenPoint,
          });
          if (
            action.type === 'left_click'
            || action.type === 'right_click'
            || action.type === 'double_click'
          ) {
            const semantic = await runElectronSemanticPointer(
              { type: action.type, screenPoint: win.screenPoint },
              win,
              signal,
              context.toolCallId,
            );
            if (semantic.handled && semantic.outcome) {
              if (
                semantic.outcome.ok
                && action.type === 'left_click'
                && (sessionGenerations.get(context.sessionId) ?? 0) === sessionGeneration
              ) {
                targetsBySession.set(context.sessionId, {
                  turnId: context.turnId,
                  target: {
                    window: win,
                    editable: semantic.result?.editable === true,
                    ...(semantic.pageTarget ? { pageTarget: semantic.pageTarget } : {}),
                  },
                });
              }
              return { outcome: semantic.outcome };
            }
          }
          {
            let snapshot: TargetSnapshot;
            try {
              snapshot = await snapshotTarget(win, signal);
            } catch (error) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'capture_failed' as const,
                  message: (error as Error).message,
                },
              };
            }
            const editableElement = editableElementAtScreenPoint(snapshot.elements, win.screenPoint);
            const element = action.type === 'middle_click'
              || action.type === 'double_click'
              || action.type === 'triple_click'
              || editableElement !== undefined
              ? undefined
              : elementAtScreenPoint(snapshot.elements, win.screenPoint);
            trace({
              type: 'snapshot',
              toolCallId: context.toolCallId,
              actionType: action.type,
              pid: win.pid,
              windowId: win.windowId,
              windowPoint: snapshot.windowPoint,
              containingElements: snapshot.elements.flatMap((candidate) => {
                if (
                  typeof candidate.element_index !== 'number'
                  || typeof candidate.role !== 'string'
                  || typeof candidate.depth !== 'number'
                  || !candidate.frame
                  || typeof candidate.frame !== 'object'
                ) return [];
                const frame = candidate.frame as Record<string, unknown>;
                if (
                  typeof frame.x !== 'number'
                  || typeof frame.y !== 'number'
                  || typeof frame.w !== 'number'
                  || typeof frame.h !== 'number'
                ) return [];
                const inside = win.screenPoint.x >= frame.x
                  && win.screenPoint.x < frame.x + frame.w
                  && win.screenPoint.y >= frame.y
                  && win.screenPoint.y < frame.y + frame.h;
                return inside ? [{
                  elementIndex: candidate.element_index,
                  role: candidate.role,
                  depth: candidate.depth,
                  frame: {
                    x: frame.x,
                    y: frame.y,
                    w: frame.w,
                    h: frame.h,
                  },
                }] : [];
              }),
              ...(editableElement ? { editableElementIndex: editableElement.element_index } : {}),
              ...(element ? { clickableElementIndex: element.element_index } : {}),
            });
            const args: Record<string, unknown> = {
              pid: win.pid,
              window_id: win.windowId,
              ...(element
                ? {
                    element_index: element.element_index,
                    ...(element.element_token ? { element_token: element.element_token } : {}),
                  }
                : { x: snapshot.windowPoint.x, y: snapshot.windowPoint.y }),
            };
            if (action.type === 'right_click') args.button = 'right';
            if (action.type === 'middle_click') args.button = 'middle';
            if (action.type === 'triple_click') args.count = 3;
            const toolName = action.type === 'double_click' ? 'double_click' : 'click';
            trace({
              type: 'dispatch',
              toolCallId: context.toolCallId,
              actionType: action.type,
              tool: toolName,
              pid: win.pid,
              windowId: win.windowId,
              address: element ? 'ax' : 'px',
            });
            const r = await actionClient.callTool(toolName, args, signal);
            const outcome = normalizeCuaDriverOutcome(r);
            trace({
              type: 'outcome',
              toolCallId: context.toolCallId,
              actionType: action.type,
              tool: toolName,
              outcome,
            });
            if (
              outcome.ok
              && action.type === 'left_click'
              && (sessionGenerations.get(context.sessionId) ?? 0) === sessionGeneration
            ) {
              targetsBySession.set(context.sessionId, {
                turnId: context.turnId,
                target: {
                  window: win,
                  editable: editableElement !== undefined,
                },
              });
            }
            return { outcome };
          }
        }
        case 'scroll': {
          // Scroll REQUIRES a pid and posts via scroll_wheel_at_xy → post_to_pid
          // (no cursor warp — the warp only exists in the empty-desktop click path).
          // Resolve the window under the point and scroll it window-locally; fail
          // closed on empty desktop (nothing scrollable there anyway).
          const win = await resolveWindowAt(action.coordinate.x, action.coordinate.y, signal);
          if (!win) {
            return {
              outcome: {
                ok: false,
                error: 'unsupported_action',
                message: "no app window under the scroll point (empty desktop) — refusing 'scroll'. Scroll over an app window instead.",
              },
            };
          }
          {
            let snapshot: TargetSnapshot;
            try {
              snapshot = await snapshotTarget(win, signal);
            } catch (error) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'capture_failed' as const,
                  message: (error as Error).message,
                },
              };
            }
            const r = await actionClient.callTool(
              'scroll',
              {
                pid: win.pid,
                window_id: win.windowId,
                x: snapshot.windowPoint.x,
                y: snapshot.windowPoint.y,
                direction: action.scrollDirection,
                amount: action.scrollAmount,
              },
              signal,
            );
            return { outcome: normalizeCuaDriverOutcome(r) };
          }
        }
        case 'left_click_drag': {
          // Press-drag-release WITHIN a single window. cua-driver's `drag` sends the
          // whole down→(interpolated moves)→up sequence through the SAME window-local
          // post_mouse_event → SLEventPostToPid/CGEventPostToPid path as click
          // (source-verified against cua-driver-rs v0.7.1: NO CGWarpMouseCursorPosition
          // anywhere on the drag path — the only warp in the whole crate is click's
          // pid-less scope:'desktop' branch, and drag has no such branch since its pid
          // is required). So a pid+window_id drag never moves the user's REAL cursor.
          // We resolve BOTH endpoints and require the SAME window: a window-local drag
          // cannot cross windows, and cross-app drag-and-drop needs a real
          // NSDraggingSession this synthetic post_to_pid path cannot establish
          // (cua-driver itself marks the result unverifiable). Fail closed on empty
          // desktop (no target window ⇒ no required pid to post to) or cross-window.
          // delivery_mode is left DEFAULT (Background) — never 'foreground', which
          // would briefly reorder window z-order/frontmost (a focus disturbance).
          const from = await resolveWindowAt(action.startCoordinate.x, action.startCoordinate.y, signal);
          const to = await resolveWindowAt(action.coordinate.x, action.coordinate.y, signal);
          if (!from || !to) {
            return {
              outcome: {
                ok: false,
                error: 'unsupported_action',
                message:
                  'drag endpoint is not over an app window (empty desktop) — refusing: the drag needs a target window/pid. '
                  + 'Drag within a single app window instead.',
              },
            };
          }
          if (from.pid !== to.pid || from.windowId !== to.windowId) {
            return {
              outcome: {
                ok: false,
                error: 'unsupported_action',
                message:
                  'drag endpoints span different windows — refusing: a background window-local drag cannot cross windows, '
                  + 'and cross-app drag-and-drop needs a real drag session. Keep both endpoints inside one window.',
              },
            };
          }
          const semantic = await runElectronSemanticPointer(
            {
              type: 'left_click_drag',
              startScreenPoint: from.screenPoint,
              endScreenPoint: to.screenPoint,
            },
            from,
            signal,
            context.toolCallId,
          );
          if (semantic.handled && semantic.outcome) {
            return { outcome: semantic.outcome };
          }
          {
            let snapshot: TargetSnapshot;
            try {
              snapshot = await snapshotTarget(from, signal);
            } catch (error) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'capture_failed' as const,
                  message: (error as Error).message,
                },
              };
            }
            const toPoint = windowPointFromSnapshot({
              screenPoint: to.screenPoint,
              windowBounds: from.bounds,
              screenshotWidthPx: snapshot.screenshotWidthPx,
              screenshotHeightPx: snapshot.screenshotHeightPx,
            });
            if (!toPoint) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'invalid_coordinate' as const,
                  message: 'drag endpoint does not map into the target window snapshot',
                },
              };
            }
            const r = await actionClient.callTool(
              'drag',
              {
                pid: from.pid,
                window_id: from.windowId,
                from_x: snapshot.windowPoint.x,
                from_y: snapshot.windowPoint.y,
                to_x: toPoint.x,
                to_y: toPoint.y,
              },
              signal,
            );
            return { outcome: normalizeCuaDriverOutcome(r) };
          }
        }
        case 'zoom': {
          // cua-driver zoom is window-scoped. Resolve both region corners in
          // the declared desktop pixel space and require one owning window,
          // then convert the crop to that window's screenshot-pixel space.
          const x1 = Math.min(action.region.x1, action.region.x2);
          const y1 = Math.min(action.region.y1, action.region.y2);
          const x2 = Math.max(action.region.x1, action.region.x2);
          const y2 = Math.max(action.region.y1, action.region.y2);
          const topLeft = await resolveWindowAt(x1, y1, signal);
          const bottomRight = await resolveWindowAt(x2, y2, signal);
          if (!topLeft || !bottomRight) {
            return {
              outcome: {
                ok: false,
                error: 'unsupported_action',
                message: 'zoom region is not fully contained in an app window.',
              },
            };
          }
          if (topLeft.pid !== bottomRight.pid || topLeft.windowId !== bottomRight.windowId) {
            return {
              outcome: {
                ok: false,
                error: 'unsupported_action',
                message: 'zoom region spans different windows; keep the region inside one app window.',
              },
            };
          }
          {
            let snapshot: TargetSnapshot;
            try {
              snapshot = await snapshotTarget(topLeft, signal);
            } catch (error) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'capture_failed' as const,
                  message: (error as Error).message,
                },
              };
            }
            const bottomRightPoint = windowPointFromSnapshot({
              screenPoint: bottomRight.screenPoint,
              windowBounds: topLeft.bounds,
              screenshotWidthPx: snapshot.screenshotWidthPx,
              screenshotHeightPx: snapshot.screenshotHeightPx,
            });
            if (!bottomRightPoint) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'invalid_coordinate' as const,
                  message: 'zoom region does not map into the target window snapshot',
                },
              };
            }
            const r = await actionClient.callTool(
              'zoom',
              {
                pid: topLeft.pid,
                window_id: topLeft.windowId,
                x1: snapshot.windowPoint.x,
                y1: snapshot.windowPoint.y,
                x2: bottomRightPoint.x,
                y2: bottomRightPoint.y,
              },
              signal,
            );
            if (r?.isError) return { outcome: normalizeCuaDriverOutcome(r) };
            const image = r?.content?.find((content) => content.type === 'image');
            if (!image?.data) {
              return { outcome: { ok: false as const, error: 'capture_failed' as const, message: 'zoom returned no image' } };
            }
            const byteLength = Buffer.from(image.data, 'base64').byteLength;
            if (exceedsComputerUseFrameCap(byteLength)) {
              return {
                outcome: {
                  ok: false as const,
                  error: 'sensitivity_blocked' as const,
                  message: `zoom frame ${byteLength}B exceeds cap`,
                },
              };
            }
            const structured = r?.structuredContent ?? {};
            return {
              outcome: { ok: true as const, tier: 'coordinate-background' as const },
              screenshot: {
                base64: image.data,
                mimeType: image.mimeType === 'image/png' ? 'image/png' as const : 'image/jpeg' as const,
                widthPx: typeof structured.width === 'number' ? structured.width : 0,
                heightPx: typeof structured.height === 'number' ? structured.height : 0,
              },
            };
          }
        }
        case 'type':
        case 'key': {
          // Target-bound keyboard: `type` may fill a native empty AX field only
          // after fresh read-back. `key` is refused because cua-driver reports
          // key events as unverifiable and user clicks can redirect renderer focus.
          const target = targetForContext(context);
          if (!target) {
            return {
              outcome: {
                ok: false,
                  error: 'unsupported_action',
                  message:
                    `keyboard action '${action.type}' has no target window yet — refusing: `
                  + 'click an editable native field before a verified text fill.',
              },
            };
          }
          if (action.type === 'type') {
            try {
              return { outcome: await fillEditableTarget(target, action.text, signal) };
            } catch (error) {
              return {
                outcome: {
                  ok: false,
                  error: 'capture_failed',
                  message: (error as Error).message,
                },
              };
            }
          }
          return {
            outcome: {
              ok: false,
              error: 'unsupported_action',
              message: 'background key chords cannot be verified without risking focus races',
            },
          };
        }
        case 'wait':
          await new Promise((res) => setTimeout(res, Math.min(action.durationMs, 10_000)));
          return { outcome: { ok: true, tier: 'coordinate-background' } };
        case 'mouse_move':
          // By design we never move the REAL cursor; the overlay hook has already
          // glided the agent cursor to this coordinate (Codex-style move_cursor).
          // Acknowledge success rather than reporting unsupported for a reasonable,
          // side-effect-free action.
          return { outcome: { ok: true, tier: 'coordinate-background' } };
        default:
          return { outcome: { ok: false, error: 'unsupported_action', message: `action '${action.type}' not mapped to cua-driver` } };
        }
      });
    },

    clearSession(sessionId) {
      targetsBySession.delete(sessionId);
      sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      targetsBySession.clear();
      sessionGenerations.clear();
      actionClient.dispose();
      captureClient.dispose();
    },
  };
}
