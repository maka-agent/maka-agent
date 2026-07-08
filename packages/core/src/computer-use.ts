// PR-CORE-CU-0 — Computer Use (host-level screen control) shared types.
//
// Contract-only today (see apps/desktop/tests/smoke.md "Path 18", gates
// S12-S18). This module is the zero-dependency type foundation the future
// PR-RUNTIME-CU action runner and PR-UI-CU-1 overlay build on. Nothing here
// executes anything; it only encodes the invariants the gates enforce so the
// runtime and renderer share one vocabulary.
//
// Design note (empirically grounded on macOS 26.5, Apple Silicon): reliable
// *background, non-focus-stealing* control of a real app is NOT uniform across
// app kinds. Public APIs give clean background dispatch only via Accessibility
// (AXPress / AXSetValue) on AX-exposed targets; coordinate input to
// Chromium/Electron background windows needs fragile private SPIs, and
// foreground pixel input moves the real cursor. The runner therefore walks a
// capability-probed ladder and MUST report which tier actually ran, so a
// degraded path is never silent (see ComputerUseDispatchTier + the `verified`
// flag on ComputerUseActionOutcome).

// --- S17: fail-closed, closed error enum -----------------------------------
// Adding a new error mode is a deliberate type-surgery change AND a smoke.md
// S17 update — keep this list and the gate in lockstep.
export const COMPUTER_USE_ERROR_CODES = [
  'permission_missing',
  'overlay_failed',
  'invalid_coordinate',
  'capture_failed',
  'sensitivity_blocked',
  'unsupported_action',
  'aborted',
  'timeout',
] as const;
export type ComputerUseErrorCode = typeof COMPUTER_USE_ERROR_CODES[number];

export function isComputerUseErrorCode(value: unknown): value is ComputerUseErrorCode {
  return typeof value === 'string' && (COMPUTER_USE_ERROR_CODES as readonly string[]).includes(value);
}

// --- Model tool contract (Anthropic computer use, client-executed) ---------
// Maka drives Claude (Opus 4.8 via the coproxy-anthropic connection), so the
// current tool type + beta header are pinned here. The model emits actions in
// a DECLARED pixel space; the runtime is the sole coordinate authority (S15)
// and owns the transform from declared px → device px → logical points.
export const COMPUTER_USE_TOOL_TYPE = 'computer_20251124' as const;
export const COMPUTER_USE_BETA_HEADER = 'computer-use-2025-11-24' as const;
// Previous generation (Sonnet 4.5 / Haiku 4.5 and earlier) — kept for adapters
// that must talk to an older model behind the same proxy.
export const COMPUTER_USE_TOOL_TYPE_LEGACY = 'computer_20250124' as const;
export const COMPUTER_USE_BETA_HEADER_LEGACY = 'computer-use-2025-01-24' as const;

// --- Normalized action vocabulary ------------------------------------------
// The runner consumes only `CuAction`. An adapter (PR-RUNTIME-CU) maps the raw
// Anthropic action (coordinate:[x,y] array, text-encoded modifiers,
// scroll_direction/amount, region:[x1,y1,x2,y2]) onto this shape, leaving room
// for a future OpenAI computer-use adapter without touching the runner.
export interface CuPoint {
  /** X in the model's declared display-pixel space, top-left origin. */
  x: number;
  y: number;
}
export interface CuRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export const CU_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type CuScrollDirection = typeof CU_SCROLL_DIRECTIONS[number];

export const CU_ACTION_TYPES = [
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'type',
  'key',
  'hold_key',
  'scroll',
  'wait',
  'zoom',
] as const;
export type CuActionType = typeof CU_ACTION_TYPES[number];

/** Modifier keys ride on `text` per the Anthropic contract (shift/ctrl/alt/super, super=Command). */
export type CuAction =
  | { type: 'screenshot' }
  | { type: 'cursor_position' }
  | { type: 'mouse_move'; coordinate: CuPoint }
  | { type: 'left_click'; coordinate: CuPoint; text?: string }
  | { type: 'right_click'; coordinate: CuPoint; text?: string }
  | { type: 'middle_click'; coordinate: CuPoint; text?: string }
  | { type: 'double_click'; coordinate: CuPoint; text?: string }
  | { type: 'triple_click'; coordinate: CuPoint; text?: string }
  | { type: 'left_mouse_down'; coordinate: CuPoint }
  | { type: 'left_mouse_up'; coordinate: CuPoint }
  | { type: 'left_click_drag'; startCoordinate: CuPoint; coordinate: CuPoint; text?: string }
  | { type: 'type'; text: string }
  | { type: 'key'; text: string }
  | { type: 'hold_key'; text: string; durationMs: number }
  | { type: 'scroll'; coordinate: CuPoint; scrollDirection: CuScrollDirection; scrollAmount: number; text?: string }
  | { type: 'wait'; durationMs: number }
  | { type: 'zoom'; region: CuRegion };

// --- S15b: typed screen-frame provider boundary ----------------------------
// Every screenshot the runtime sends to the model is wrapped so it belongs to
// exactly ONE in-flight action, carries its source kind, and is size-capped.
// Raw frames are held in main-process memory for the action and never persisted
// to the session log (a StorageRef is logged instead — see ToolResultContent
// `image` kind in events.ts).
export const COMPUTER_USE_FRAME_SOURCE_KINDS = ['live-capture', 'cached-still'] as const;
export type ComputerUseFrameSourceKind = typeof COMPUTER_USE_FRAME_SOURCE_KINDS[number];

/**
 * Max encoded bytes of a single frame sent to a provider. Mirrors the artifact
 * preview registry cap (@maka/ui IMAGE_PAYLOAD_MAX_BYTES = 2 MB); an oversize
 * frame is a `sensitivity_blocked`, never a silent downscale-and-upload (S15b).
 * Kept here (not imported from @maka/ui) because @maka/core is zero-dependency.
 */
export const COMPUTER_USE_FRAME_MAX_BYTES = 2 * 1024 * 1024;

export interface ComputerUseScreenFrame {
  /** The in-flight action this frame belongs to; cross-action reuse is invalid. */
  actionId: string;
  sourceKind: ComputerUseFrameSourceKind;
  mimeType: 'image/png' | 'image/jpeg';
  /** Frame dimensions in the exact pixel space handed to the model. */
  widthPx: number;
  heightPx: number;
  /** Encoded byte length; MUST satisfy !exceedsComputerUseFrameCap(byteLength). */
  byteLength: number;
  capturedAt: number;
}

export function exceedsComputerUseFrameCap(byteLength: number): boolean {
  return byteLength > COMPUTER_USE_FRAME_MAX_BYTES;
}

// --- Capability-probed dispatch ladder (transparent degradation) -----------
// The runner reports which rung actually executed so the UI/log can label a
// degraded path. Never silently no-op or silently fall back (aligns with the
// project rule: no defensive fixes that mask failures).
export const COMPUTER_USE_DISPATCH_TIERS = [
  // Public API, genuinely background: AXUIElementPerformAction/AXSetValue on
  // AX-exposed targets — no cursor move, no focus steal, notarizable.
  'ax',
  // Private, best-effort background: coordinate injection for non-AX targets.
  'coordinate-background',
  // Honest fallback: foreground-visible pixel input (moves the real cursor);
  // per-action opt-in, labeled degraded.
  'foreground-visible',
] as const;
export type ComputerUseDispatchTier = typeof COMPUTER_USE_DISPATCH_TIERS[number];

/**
 * Runner outcome. Success carries the tier that ran and whether a post-action
 * verification observed the intended state change (`verified:false` on a
 * mutating action means the dispatch silently did nothing → the runner MUST
 * surface it as `capture_failed`/a typed error, not report success). Failure
 * carries the closed S17 error and the count of completed sub-steps (S18).
 */
export type ComputerUseActionOutcome =
  | {
      ok: true;
      tier: ComputerUseDispatchTier;
      /** Post-action verification result; undefined for non-mutating actions (screenshot/wait). */
      verified?: boolean;
      frame?: ComputerUseScreenFrame;
      completedSubSteps?: number;
    }
  | {
      ok: false;
      error: ComputerUseErrorCode;
      message: string;
      completedSubSteps?: number;
    };
