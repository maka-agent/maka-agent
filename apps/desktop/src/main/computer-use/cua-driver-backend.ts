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
// KEYBOARD FAILS CLOSED HERE. Not because the mechanism is unsafe — verified
// against the real driver, cua-driver's type_text/press_key ARE background-safe
// (delivery_mode:"background" = no fronting/raising/focus-steal) and target an
// explicit pid. The problem is *which* pid: the flat Anthropic computer grammar
// (type/key carry only `text`, no target) gives no window/pid context, and a
// scope:'desktop' click does not raise/focus its target — so the only pid we
// could GUESS is the OS-frontmost app = the user's active window. Typing there
// would violate the non-negotiable "never disturb the user's active app". Doing
// it right needs the element/window flow (get_accessibility_tree / get_window_state
// → owner pid or element_index+window_id → type_text{pid, delivery_mode:background}),
// which this coordinate-oriented backend does not implement yet. Until then type/key
// return a truthful `unsupported_action` rather than guess. (The Tier-1 AX helper
// backend already does targeted background typing to a resolved pid.)
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type CuAction,
  type ComputerUseActionOutcome,
  isComputerUseErrorCode,
  exceedsComputerUseFrameCap,
} from '@maka/core';
import type { CuDispatchBackend, CuRunResult, CuScreenshot } from '@maka/runtime';

const DEFAULT_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Defensive transport bound. A legitimate frame is a single multi-MB base64
// line (~2.7MB for the 2MB-capped PNG); an order of magnitude beyond that is a
// runaway/garbage stream, so we tear down instead of growing memory unbounded.
const MAX_STDOUT_BUFFER = 32 * 1024 * 1024;
const STDERR_TAIL_CAP = 4096;

export interface CuaDriverBackendOptions {
  /** Absolute path to the bundled `cua-driver` binary. */
  binaryPath: string;
  /** The host app's bundle id, for TCC responsibility-chain inheritance. */
  hostBundleId: string;
  timeoutMs?: number;
  /** Per-request bound on the startup handshake (defaults to HANDSHAKE_TIMEOUT_MS). */
  handshakeTimeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
  error?: { code: number; message: string };
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

  constructor(private readonly opts: CuaDriverBackendOptions) {}

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
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
    // Neutralize cua-driver's install-ping (the one telemetry event its env
    // opt-out does NOT stop) by pre-seeding its marker file. Best-effort.
    try {
      const dir = join(homedir(), '.cua-driver');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.installation_recorded'), '1', { flag: 'wx' });
    } catch {
      /* non-fatal */
    }

    const child = spawn(this.opts.binaryPath, ['mcp', '--embedded', '--no-daemon-relaunch', '--no-overlay', '--host-bundle-id', this.opts.hostBundleId], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
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
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    // Drain stderr into a bounded tail. An undrained piped stderr fills its OS
    // pipe buffer (~64KB), blocks the child's writes, and wedges all RPC.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    // An EPIPE/ERR_STREAM_DESTROYED during the child's crash window is emitted
    // as a stdin 'error' event; unhandled it crashes the Electron main process.
    // Route it into the orderly teardown instead.
    child.stdin.on('error', () => this.onExit());
    child.on('exit', () => this.onExit());
    child.on('error', () => this.onExit());

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
      // `session` is deliberately never opened → no cursor overlay.
      this.notify('notifications/initialized');
      // Desktop-scope capture must be enabled once (persisted to config.json).
      // Fail CLOSED: if set_config errors, reject start() rather than warn-and-
      // continue — otherwise later scope:'desktop' actions would silently run
      // against an unconfigured scope while reporting ok. Use request() directly
      // (not callTool) to avoid re-entering the in-flight ensureStarted().
      const cfg = await this.request(
        'tools/call',
        { name: 'set_config', arguments: { capture_scope: 'desktop' } },
        { timeoutMs: handshakeTimeoutMs },
      );
      if (cfg.error) throw new Error(`set_config capture_scope=desktop failed: ${cfg.error.message}`);
    } catch (e) {
      this.kill();
      throw e;
    }
  }

  private onStdout(chunk: string): void {
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

  private onStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CAP);
  }

  private onExit(): void {
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
    await this.ensureStarted(signal);
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
    this.child?.kill('SIGKILL');
    this.onExit();
  }
}

function toOutcome(result: JsonRpcResponse['result'], tierVerified: boolean | undefined): ComputerUseActionOutcome {
  if (result?.isError) {
    const text = result.content?.find((c) => c.type === 'text')?.text ?? 'cua-driver reported an error';
    // cua-driver text errors aren't our S17 codes; classify conservatively.
    const raw = typeof result.structuredContent?.error === 'string' ? result.structuredContent.error : '';
    const err = isComputerUseErrorCode(raw) ? raw : 'capture_failed';
    return { ok: false, error: err, message: text };
  }
  return { ok: true, tier: 'coordinate-background', verified: tierVerified };
}

export function createCuaDriverBackend(opts: CuaDriverBackendOptions): CuDispatchBackend & { dispose: () => void } {
  const client = new CuaDriverClient(opts);

  // Cached backing scale (device px per logical point). The model's click
  // coordinate is in get_desktop_state DEVICE pixels; window bounds from
  // list_windows are in logical SCREEN POINTS, so we convert with this.
  let scaleFactor: number | undefined;
  async function getScale(signal: AbortSignal): Promise<number> {
    if (scaleFactor && scaleFactor > 0) return scaleFactor;
    try {
      const r = await client.callTool('get_screen_size', {}, signal);
      const sc = r?.structuredContent ?? {};
      const sf = typeof sc.scale_factor === 'number' && sc.scale_factor > 0 ? sc.scale_factor : 1;
      scaleFactor = sf;
      return sf;
    } catch {
      return 1;
    }
  }

  interface ResolvedWindow { pid: number; windowId: number; localX: number; localY: number }

  /**
   * Resolve the frontmost on-screen app window under a DEVICE-pixel click point,
   * mirroring cua-driver's own scope:'desktop' resolution (screen-point space,
   * layer-0, highest z_index wins). Returns the target pid + window_id + the
   * window-local DEVICE coordinate. Null when NO app window owns the pixel (empty
   * desktop) — where cua-driver would warp the real cursor, so we must refuse.
   * Excludes non-layer-0 windows, which also excludes Maka's always-on-top overlay.
   */
  async function resolveWindowAt(deviceX: number, deviceY: number, signal: AbortSignal): Promise<ResolvedWindow | null> {
    const scale = await getScale(signal);
    const sx = deviceX / scale;
    const sy = deviceY / scale;
    const r = await client.callTool('list_windows', {}, signal);
    const wins = (r?.structuredContent?.windows ?? []) as Array<Record<string, unknown>>;
    const containing = wins
      .filter((w) => {
        const b = w.bounds as { x: number; y: number; width: number; height: number } | undefined;
        return w.layer === 0 && w.is_on_screen !== false && b
          && sx >= b.x && sx < b.x + b.width && sy >= b.y && sy < b.y + b.height
          && typeof w.pid === 'number' && typeof w.window_id === 'number';
      })
      .sort((a, b) => (Number(b.z_index) || 0) - (Number(a.z_index) || 0));
    const w = containing[0];
    if (!w) return null;
    const b = w.bounds as { x: number; y: number };
    // window-local DEVICE px = model device coord − window origin (device).
    return {
      pid: w.pid as number,
      windowId: w.window_id as number,
      localX: deviceX - b.x * scale,
      localY: deviceY - b.y * scale,
    };
  }

  return {
    async preflight(signal) {
      const r = await client.callTool('check_permissions', { prompt: false }, signal);
      const sc = r?.structuredContent ?? {};
      return {
        accessibility: sc.accessibility === true,
        // Prefer the live ScreenCaptureKit probe over the cached boolean.
        screenRecording: sc.screen_recording_capturable === true || sc.screen_recording === true,
      };
    },

    async run(action, signal): Promise<CuRunResult> {
      switch (action.type) {
        case 'screenshot': {
          const r = await client.callTool('get_desktop_state', {}, signal);
          const img = r?.content?.find((c) => c.type === 'image');
          if (!img?.data) return { outcome: { ok: false, error: 'capture_failed', message: 'no image returned' } };
          const bytes = Buffer.from(img.data, 'base64');
          if (exceedsComputerUseFrameCap(bytes.byteLength)) {
            return { outcome: { ok: false, error: 'sensitivity_blocked', message: `frame ${bytes.byteLength}B exceeds cap` } };
          }
          const sc = r?.structuredContent ?? {};
          const screenshot: CuScreenshot = {
            base64: img.data,
            mimeType: img.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
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
          const args: Record<string, unknown> = { pid: win.pid, window_id: win.windowId, x: win.localX, y: win.localY };
          if (action.type === 'right_click') args.button = 'right';
          if (action.type === 'middle_click') args.button = 'middle';
          if (action.type === 'double_click') args.count = 2;
          if (action.type === 'triple_click') args.count = 3;
          const r = await client.callTool('click', args, signal);
          return { outcome: toOutcome(r, undefined) };
        }
        case 'scroll':
          // Same hazard as click: desktop-scope scroll warps the real cursor. Fail closed.
          return {
            outcome: {
              ok: false,
              error: 'unsupported_action',
              message: "'scroll' is disabled on the cua-driver backend: desktop-scope scroll moves the user's real cursor; pid-targeted scroll not yet wired.",
            },
          };
        case 'type':
        case 'key':
          // FAIL CLOSED — see the module header. cua-driver keyboard is background-
          // safe (delivery_mode:"background", no focus steal) but needs a *target
          // pid*; the flat grammar carries none, and guessing frontmost = the user's
          // active window. We refuse honestly rather than guess (upgrade path: resolve
          // the target pid via get_accessibility_tree / get_window_state, then type
          // to THAT pid — never frontmost).
          return {
            outcome: {
              ok: false,
              error: 'unsupported_action',
              message:
                `keyboard action '${action.type}' is unavailable via the cua-driver backend `
                + '(its only resolvable target is the frontmost/your active window); '
                + 'use the AX-helper backend (MAKA_CU_BACKEND=ax-helper) for background typing to a specific target',
            },
          };
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
    },

    dispose() {
      client.kill();
    },
  };
}
