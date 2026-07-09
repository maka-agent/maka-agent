// PR-RUNTIME-CU (desktop half) — the CuDispatchBackend that spawns the signed
// Swift helper and speaks its NDJSON protocol. This is the concrete Tier-1
// backend injected into buildComputerUseTools({ backend }) in @maka/runtime.
//
// Transport: per-request spawn. Each call launches `maka-cu-helper`, writes ONE
// JSON request line, closes stdin (the helper's readLine loop then emits one
// response line and exits on EOF), and parses the first response line. This
// keeps the helper stateless and avoids request/response correlation; the
// spawn cost (~tens of ms) is negligible against an LLM turn. A persistent
// helper is a later optimization behind this same interface.
//
// The helper inherits the Electron app's TCC grants (it is a child process), so
// no second permission prompt. Path 18 duties that are OS-independent (per-
// action TCC re-check, typed errors, abort) live in the @maka/runtime tool; this
// module only marshals CuAction → helper op and back.
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type CuAction,
  type ComputerUseActionOutcome,
  isComputerUseErrorCode,
  exceedsComputerUseFrameCap,
} from '@maka/core';
import type { CuDispatchBackend, CuRunResult, CuScreenshot } from '@maka/runtime';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface HelperBackendOptions {
  /** Absolute path to the built `maka-cu-helper` binary. */
  helperPath: string;
  timeoutMs?: number;
}

type HelperResponse = Record<string, unknown>;

/** Spawn the helper, send one NDJSON request, resolve its one-line response. */
function callHelper(
  helperPath: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new Error('timeout')));
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      done(() => reject(new Error('aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', () =>
      done(() => {
        const line = out.split('\n').find((l) => l.trim().length > 0);
        if (!line) {
          reject(new Error('helper returned no response'));
          return;
        }
        try {
          resolve(JSON.parse(line) as HelperResponse);
        } catch (err) {
          reject(new Error(`helper response not JSON: ${(err as Error).message}`));
        }
      }),
    );

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

/** Map a helper JSON response onto the typed ComputerUseActionOutcome. */
function toOutcome(res: HelperResponse): ComputerUseActionOutcome {
  if (res.ok === true) {
    return {
      ok: true,
      tier: 'ax',
      verified: typeof res.verified === 'boolean' ? res.verified : undefined,
      completedSubSteps: typeof res.completedSubSteps === 'number' ? res.completedSubSteps : undefined,
    };
  }
  const error = isComputerUseErrorCode(res.error) ? res.error : 'capture_failed';
  return {
    ok: false,
    error,
    message: typeof res.message === 'string' ? res.message : 'helper reported failure',
    completedSubSteps: typeof res.completedSubSteps === 'number' ? res.completedSubSteps : undefined,
  };
}

const CLICK_ACTIONS = new Set<CuAction['type']>([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
]);

export function createHelperBackend(opts: HelperBackendOptions): CuDispatchBackend {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async preflight(signal) {
      const res = await callHelper(opts.helperPath, { op: 'preflight' }, signal, timeoutMs);
      return {
        accessibility: res.accessibility === true,
        screenRecording: res.screenRecording === true,
      };
    },

    async run(action, signal): Promise<CuRunResult> {
      // Capture: helper writes a PNG we read back to base64 for the model (S15b).
      if (action.type === 'screenshot') {
        const out = join(tmpdir(), `maka-cu-${randomUUID()}.png`);
        try {
          const res = await callHelper(opts.helperPath, { op: 'screenshot', out }, signal, timeoutMs);
          const outcome = toOutcome(res);
          if (!outcome.ok) return { outcome };
          const bytes = await readFile(out);
          if (exceedsComputerUseFrameCap(bytes.byteLength)) {
            return { outcome: { ok: false, error: 'sensitivity_blocked', message: `frame ${bytes.byteLength}B exceeds cap` } };
          }
          const screenshot: CuScreenshot = {
            base64: bytes.toString('base64'),
            mimeType: 'image/png',
            widthPx: typeof res.widthPx === 'number' ? res.widthPx : 0,
            heightPx: typeof res.heightPx === 'number' ? res.heightPx : 0,
          };
          return { outcome, screenshot };
        } finally {
          await unlink(out).catch(() => {});
        }
      }

      if (CLICK_ACTIONS.has(action.type) && 'coordinate' in action) {
        const res = await callHelper(
          opts.helperPath,
          { op: 'click', x: action.coordinate.x, y: action.coordinate.y },
          signal,
          timeoutMs,
        );
        return { outcome: toOutcome(res) };
      }

      if (action.type === 'type') {
        const res = await callHelper(opts.helperPath, { op: 'type', text: action.text }, signal, timeoutMs);
        return { outcome: toOutcome(res) };
      }

      if (action.type === 'key') {
        const res = await callHelper(opts.helperPath, { op: 'key', text: action.text }, signal, timeoutMs);
        return { outcome: toOutcome(res) };
      }

      if (action.type === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(action.durationMs, 10_000)));
        return { outcome: { ok: true, tier: 'ax' } };
      }

      // helper v1 does not implement mouse_move / drag / scroll / zoom /
      // hold_key / cursor_position yet. Fail closed, honestly — never pretend.
      return {
        outcome: {
          ok: false,
          error: 'capture_failed',
          message: `action '${action.type}' is not implemented in maka-cu-helper v1`,
        },
      };
    },
  };
}
