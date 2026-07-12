// PR-RUNTIME-CU — the model-facing `computer` tool + its dispatch seam.
//
// This is platform-agnostic: the actual host input/capture is done by an
// injected `CuDispatchBackend` (the desktop app spawns the signed Swift helper
// and implements this interface). The tool owns the Path 18 obligations that
// are OS-independent: per-action TCC re-check (S12), coordinate authority stays
// runtime-side (S15), a closed typed-error surface (S17), and AbortSignal
// threading (S18). The backend owns the actual AX/capture dispatch.
import { z } from 'zod';
import {
  CU_ACTION_TYPES,
  type CuAction,
  type CuPoint,
  type ComputerUseActionOutcome,
  type ComputerUseDispatchEvidence,
} from '@maka/core';
import { redactSecrets } from '@maka/core/redaction';
import type { MakaTool } from './tool-runtime.js';

const COMPUTER_USE_CATEGORY = 'computer_use';

/** A screenshot the backend captured, ready to be surfaced to the model. */
export interface CuScreenshot {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
}

export interface CuRunResult {
  outcome: ComputerUseActionOutcome;
  /** Present for `screenshot`, and (by convention) after a mutating action so
   *  the model can SEE the result — the authoritative verification (S17). */
  screenshot?: CuScreenshot;
}

export interface CuRunContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
}

/**
 * The host dispatch seam. Implemented in @maka/computer-use by the cua-driver
 * backend, which spawns trycua/cua-driver and speaks its JSON-RPC protocol over
 * stdio. Alternative backends can plug in behind this same interface later.
 */
export interface CuDispatchBackend {
  /** Live macOS TCC status. Called at EVERY action-start — cached "granted" is
   *  insufficient because the user can revoke at any time (S12). */
  preflight(signal: AbortSignal): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  /** Execute one normalized action; capture a fresh frame where applicable. */
  run(action: CuAction, signal: AbortSignal, context: CuRunContext): Promise<CuRunResult>;
}

/** Context the overlay hook needs to key its per-action cursor + per-session teardown. */
export interface CuOverlayHookContext {
  sessionId: string;
  toolCallId: string;
}

/**
 * Optional visual seam: notified at each action's start (with the normalized
 * `CuAction`, whose coordinate is in declared px) so a host can drive an agent-
 * cursor overlay. Purely additive + display-only — it never affects dispatch,
 * coordinates, or the real pointer. Backend-agnostic: it sits ABOVE `backend.run`,
 * so it fires identically regardless of which host dispatch backend runs the action.
 */
export interface CuOverlayHook {
  onActionBegin(action: CuAction, ctx: CuOverlayHookContext): void;
  onActionEnd?(action: CuAction, result: CuRunResult | undefined, ctx: CuOverlayHookContext): void;
}

const coordinate = z.tuple([z.number(), z.number()]);
const computerParams = z.object({
  action: z.enum(CU_ACTION_TYPES as unknown as [string, ...string[]]),
  coordinate: coordinate.optional(),
  start_coordinate: coordinate.optional(),
  text: z.string().max(8000).optional(),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(0).max(100).optional(),
  duration: z.number().min(0).max(60).optional(),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});
type ComputerParams = z.infer<typeof computerParams>;

const point = (c?: [number, number]): CuPoint | undefined => (c ? { x: c[0], y: c[1] } : undefined);

/**
 * Map the flat Anthropic action grammar onto the discriminated `CuAction` the
 * backend consumes. Throws on a malformed action (missing required field); the
 * runtime converts the throw into an error tool-result.
 */
export function adaptToCuAction(args: ComputerParams): CuAction {
  const need = (c?: [number, number]): CuPoint => {
    const p = point(c);
    if (!p) throw new Error(`invalid_coordinate: action '${args.action}' requires coordinate`);
    return p;
  };
  const needText = (): string => {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      throw new Error(`invalid_coordinate: action '${args.action}' requires text`);
    }
    return args.text;
  };
  switch (args.action) {
    case 'screenshot': return { type: 'screenshot' };
    case 'cursor_position': return { type: 'cursor_position' };
    case 'mouse_move': return { type: 'mouse_move', coordinate: need(args.coordinate) };
    case 'left_click': return { type: 'left_click', coordinate: need(args.coordinate), text: args.text };
    case 'right_click': return { type: 'right_click', coordinate: need(args.coordinate), text: args.text };
    case 'middle_click': return { type: 'middle_click', coordinate: need(args.coordinate), text: args.text };
    case 'double_click': return { type: 'double_click', coordinate: need(args.coordinate), text: args.text };
    case 'triple_click': return { type: 'triple_click', coordinate: need(args.coordinate), text: args.text };
    case 'left_mouse_down': return { type: 'left_mouse_down', coordinate: need(args.coordinate) };
    case 'left_mouse_up': return { type: 'left_mouse_up', coordinate: need(args.coordinate) };
    case 'left_click_drag':
      return { type: 'left_click_drag', startCoordinate: need(args.start_coordinate), coordinate: need(args.coordinate), text: args.text };
    case 'type': return { type: 'type', text: needText() };
    case 'key': return { type: 'key', text: needText() };
    case 'hold_key': return { type: 'hold_key', text: needText(), durationMs: Math.round((args.duration ?? 0) * 1000) };
    case 'scroll':
      return {
        type: 'scroll',
        coordinate: need(args.coordinate),
        scrollDirection: args.scroll_direction ?? 'down',
        scrollAmount: args.scroll_amount ?? 3,
        text: args.text,
      };
    case 'wait': return { type: 'wait', durationMs: Math.round((args.duration ?? 0) * 1000) };
    case 'zoom': {
      if (!args.region) throw new Error("invalid_coordinate: action 'zoom' requires region");
      const [x1, y1, x2, y2] = args.region;
      return { type: 'zoom', region: { x1, y1, x2, y2 } };
    }
    default:
      throw new Error(`invalid_coordinate: unknown action '${String(args.action)}'`);
  }
}

/** Concise, model-facing summary of an outcome (S16-safe: no screen text here). */
function summarizeEvidence(evidence: ComputerUseDispatchEvidence | undefined): string {
  if (!evidence) return '';
  const safeToken = (value: string): string | undefined =>
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : undefined;
  const fields: string[] = [];
  const path = evidence.path ? safeToken(evidence.path) : undefined;
  if (path) fields.push(`path=${path}`);
  if (evidence.effect) fields.push(`effect=${evidence.effect}`);
  if (evidence.escalation) {
    const recommended = safeToken(evidence.escalation.recommended);
    if (recommended) {
      fields.push(
        recommended === 'foreground'
          ? 'escalation=foreground(disallowed)'
          : `escalation=${recommended}`,
      );
    }
  }
  return fields.length > 0 ? `; dispatch ${fields.join(', ')}` : '';
}

function summarize(action: CuAction, result: CuRunResult): string {
  const { outcome } = result;
  const evidence = summarizeEvidence(outcome.evidence);
  if (!outcome.ok) {
    // Driver messages and escalation reasons may contain AX labels, window
    // titles, or screen text. Keep them in internal evidence only; the
    // model/session summary exposes controlled codes and short identifiers.
    return `computer.${action.type} failed: ${outcome.error}${evidence}`
      + (typeof outcome.completedSubSteps === 'number' ? ` (completed ${outcome.completedSubSteps} sub-steps)` : '');
  }
  const verified = outcome.verified === undefined ? 'n/a' : String(outcome.verified);
  const shot = result.screenshot ? `; screenshot ${result.screenshot.widthPx}x${result.screenshot.heightPx}` : '';
  return `computer.${action.type} ok via ${outcome.tier} (verified=${verified})${evidence}${shot}`
    + (outcome.verified === false ? ' — dispatch could not be confirmed; re-screenshot to verify' : '');
}

/**
 * Raw result of the `computer` tool. `text` is the S16-safe summary the runtime
 * records to session history (via coerceResultContent's text-only projection:
 * this object has no `kind`, so only `text` survives). `screenshot`, when
 * present, rides along ONLY to feed `toModelOutput` — it never enters `text`, so
 * the bounded frame base64 stays out of session history.
 */
interface ComputerToolResult {
  text: string;
  screenshot?: { base64: string; mimeType: string };
}

export function buildComputerUseTools(deps: { backend: CuDispatchBackend; overlay?: CuOverlayHook }): MakaTool[] {
  let invocationQueue = Promise.resolve();

  async function withInvocationQueue<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = invocationQueue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    invocationQueue = previous.then(() => gate);
    await previous;
    try {
      if (signal.aborted) throw new Error('aborted');
      return await operation();
    } finally {
      release();
    }
  }

  const tool: MakaTool<ComputerParams, ComputerToolResult> = {
    name: 'computer',
    displayName: '电脑控制',
    description:
      'Control the host computer via macOS Accessibility: take a screenshot, click, mouse_move, scroll, and drag on the user\'s real apps. '
      + 'Actions run in the BACKGROUND without stealing keyboard focus or moving the user\'s REAL mouse cursor — instead a visual '
      + 'agent-cursor glides to where you act, so the user sees your attention without being interrupted. Use mouse_move to glide the '
      + 'agent-cursor to a target, then click/scroll to act there. Use left_click_drag (start_coordinate → coordinate) for marquee/lasso '
      + 'selection, sliders, or resizing — but only WITHIN a single window; a drag whose endpoints land in different windows is refused '
      + '(cross-app drag-and-drop is not supported). Coordinates are in the declared display-pixel space (the runtime maps '
      + 'them to the real screen). Prefer this over shelling out to cliclick/screencapture for host GUI control. Text: after clicking an '
      + 'empty native AX text field, type may fill it only when a fresh AX read-back confirms the value. Electron/unknown targets, '
      + 'non-empty fields, and all key chords are refused because background key events race with the user\'s focus. '
      + 'Never used for web pages inside Maka (use the browser tools for those).',
    parameters: computerParams,
    categoryHint: COMPUTER_USE_CATEGORY as MakaTool['categoryHint'],
    impl: async (args, {
      abortSignal,
      sessionId,
      turnId,
      toolCallId,
    }): Promise<ComputerToolResult> => {
      if (abortSignal.aborted) return { text: 'computer aborted before start' };
      return withInvocationQueue(abortSignal, async () => {
        // S12: re-check TCC at action-start; cached "granted" is insufficient.
        const tcc = await deps.backend.preflight(abortSignal);
        if (!tcc.accessibility) {
          return { text: 'computer failed: permission_missing — Accessibility not granted (System Settings → Privacy & Security → Accessibility)' };
        }
        const action = adaptToCuAction(args);
        // A capture-bearing action additionally needs Screen Recording (S12).
        const capturing = action.type === 'screenshot' || action.type === 'zoom';
        if (capturing && !tcc.screenRecording) {
          return { text: 'computer failed: permission_missing — Screen Recording not granted (System Settings → Privacy & Security → Screen Recording)' };
        }
        // Visual seam: drive the agent-cursor overlay at the coordinate authority
        // point (declared px in `action`), backend-agnostic and display-only. Never
        // throws into dispatch — a broken overlay must not break the action.
        const overlayCtx = { sessionId, toolCallId };
        const runCtx: CuRunContext = { sessionId, turnId, toolCallId };
        try { deps.overlay?.onActionBegin(action, overlayCtx); } catch { /* overlay is best-effort */ }
        let result: CuRunResult | undefined;
        try {
          result = await deps.backend.run(action, abortSignal, runCtx);
          // Carry the screenshot base64 on the raw result (which becomes the ai-sdk
          // tool `output`) so `toModelOutput` below can hand the vision model an image
          // block. Kept OFF `text`: coerceResultContent projects this object to a
          // text-only session-log entry (no `kind` ⇒ only `text` survives), so the
          // bounded frame never bloats history.
          const text = summarize(action, result);
          return result.screenshot
            ? { text, screenshot: { base64: result.screenshot.base64, mimeType: result.screenshot.mimeType } }
            : { text };
        } finally {
          try { deps.overlay?.onActionEnd?.(action, result, overlayCtx); } catch { /* best-effort */ }
        }
      });
    },
    // Map the raw result into model-visible content: the summary as text, plus the
    // screenshot as a native image block when present. @ai-sdk/anthropic maps
    // `image-data` → an Anthropic image block. Robust to the runtime's synthetic
    // failure return shape ({ error }) from permission/loop-gate blocks, which
    // reaches here as `output` too.
    toModelOutput: ({ output }) => {
      const o = (output ?? {}) as Partial<ComputerToolResult> & { error?: unknown };
      const text = typeof o.text === 'string'
        ? redactSecrets(o.text)
        : typeof o.error === 'string'
          ? redactSecrets(o.error)
          : 'computer: no result';
      return {
        type: 'content',
        value: [
          { type: 'text', text },
          ...(o.screenshot
            ? [{ type: 'image-data' as const, data: o.screenshot.base64, mediaType: o.screenshot.mimeType }]
            : []),
        ],
      };
    },
  };
  return [tool];
}
