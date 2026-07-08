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
} from '@maka/core';
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

/**
 * The host dispatch seam. Implemented by @maka/desktop, which spawns the signed
 * `maka-cu-helper` and speaks its NDJSON protocol. Tier-2 (private-SkyLight) and
 * Tier-3 (foreground) backends plug in behind this same interface later.
 */
export interface CuDispatchBackend {
  /** Live macOS TCC status. Called at EVERY action-start — cached "granted" is
   *  insufficient because the user can revoke at any time (S12). */
  preflight(signal: AbortSignal): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  /** Execute one normalized action; capture a fresh frame where applicable. */
  run(action: CuAction, signal: AbortSignal): Promise<CuRunResult>;
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
function summarize(action: CuAction, result: CuRunResult): string {
  const { outcome } = result;
  if (!outcome.ok) {
    return `computer.${action.type} failed: ${outcome.error}${outcome.message ? ` — ${outcome.message}` : ''}`
      + (typeof outcome.completedSubSteps === 'number' ? ` (completed ${outcome.completedSubSteps} sub-steps)` : '');
  }
  const verified = outcome.verified === undefined ? 'n/a' : String(outcome.verified);
  const shot = result.screenshot ? `; screenshot ${result.screenshot.widthPx}x${result.screenshot.heightPx}` : '';
  return `computer.${action.type} ok via ${outcome.tier} (verified=${verified})${shot}`
    + (outcome.verified === false ? ' — dispatch could not be confirmed; re-screenshot to verify' : '');
}

export function buildComputerUseTools(deps: { backend: CuDispatchBackend }): MakaTool[] {
  const tool: MakaTool<ComputerParams, unknown> = {
    name: 'computer',
    displayName: '电脑控制',
    description:
      'Control the host computer via macOS Accessibility: take a screenshot, click, type, key, scroll on the user\'s real apps. '
      + 'Actions run in the BACKGROUND without stealing focus or moving the cursor. Coordinates are in the declared display-pixel '
      + 'space (the runtime maps them to the real screen). A click that reports verified=false did not confirm its effect — take a '
      + 'screenshot to check. Never used for web pages inside Maka (use the browser tools for those).',
    parameters: computerParams,
    categoryHint: COMPUTER_USE_CATEGORY as MakaTool['categoryHint'],
    impl: async (args, { abortSignal }) => {
      if (abortSignal.aborted) return { kind: 'text', text: 'computer aborted before start' };
      // S12: re-check TCC at action-start; cached "granted" is insufficient.
      const tcc = await deps.backend.preflight(abortSignal);
      if (!tcc.accessibility) {
        return { kind: 'text', text: 'computer failed: permission_missing — Accessibility not granted (System Settings → Privacy & Security → Accessibility)' };
      }
      const action = adaptToCuAction(args);
      // A capture-bearing action additionally needs Screen Recording (S12).
      const capturing = action.type === 'screenshot' || action.type === 'zoom';
      if (capturing && !tcc.screenRecording) {
        return { kind: 'text', text: 'computer failed: permission_missing — Screen Recording not granted (System Settings → Privacy & Security → Screen Recording)' };
      }
      const result = await deps.backend.run(action, abortSignal);
      // NOTE (next increment, gated on the installed ai-sdk image-return shape):
      // when result.screenshot is present, return it as an image content block so
      // the vision model can SEE the new state. Until that wiring lands, surface a
      // faithful text summary + the frame dimensions.
      return { kind: 'text', text: summarize(action, result) };
    },
  };
  return [tool];
}
