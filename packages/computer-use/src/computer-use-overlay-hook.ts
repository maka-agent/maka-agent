// Maps normalized CuActions → the cursor overlay controller. This is where the
// Path 18 S15 coordinate authority lives on the desktop side: the model's action
// coordinate (declared px = the true screen pixels of get_desktop_state) is
// transformed to a logical screen point here in MAIN, then handed to the overlay.
// Backend-agnostic: fed from buildComputerUseTools' `overlay` seam, above dispatch.
import type { CuAction, CuPoint } from '@maka/core';
import type { CuOverlayHook } from '@maka/runtime';

/** The overlay cursor action kinds the hook classifies actions into. */
export type CursorActionKind = 'move' | 'click' | 'drag' | 'scroll';

/** One per-action cursor move, in SCREEN (logical) coordinates. */
export interface CursorMoveInput {
  actionId: string;
  sessionId: string;
  screenX: number;
  screenY: number;
  kind: CursorActionKind;
  pressed?: boolean;
}

/**
 * The minimal surface the hook drives — the visual side of computer-use. The
 * desktop's Electron overlay controller implements this (BrowserWindow); a
 * headless surface (CLI) can pass a no-op. Decoupling the hook from the Electron
 * controller is what lets this package be shared by both GUI and CLI.
 */
export interface OverlayCursorSink {
  ensure(sessionId: string): void;
  move(input: CursorMoveInput): void;
}

interface DisplayLike {
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}
export interface OverlayScreenLike {
  getPrimaryDisplay(): DisplayLike;
}

/** Actions that carry a screen coordinate the cursor should move to. */
function coordinateOf(action: CuAction): CuPoint | undefined {
  switch (action.type) {
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'scroll':
    case 'left_click_drag':
      return action.coordinate;
    default:
      return undefined; // type/key/hold_key/wait/screenshot/cursor_position/zoom
  }
}

function kindOf(action: CuAction): CursorActionKind {
  switch (action.type) {
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return 'click';
    case 'left_click_drag':
      return 'drag';
    case 'scroll':
      return 'scroll';
    default:
      return 'move';
  }
}

/**
 * Transform a declared-px action coordinate (device pixels relative to the
 * primary display top-left) into a logical screen point. On a 1× display this is
 * the identity; on Retina it divides by scaleFactor and offsets by the display's
 * logical origin.
 */
export function declaredPxToScreenPoint(pt: CuPoint, display: DisplayLike): { x: number; y: number } {
  const scale = display.scaleFactor || 1;
  return { x: display.bounds.x + pt.x / scale, y: display.bounds.y + pt.y / scale };
}

/** Build the overlay hook that drives `controller` from CU actions. */
export function createComputerUseOverlayHook(controller: OverlayCursorSink, screen: OverlayScreenLike): CuOverlayHook {
  const debug = Boolean(process.env.MAKA_CU_E2E_PROMPT);
  return {
    onActionBegin(action, ctx) {
      const pt = coordinateOf(action);
      if (!pt) {
        // Non-coordinate action (type/key/screenshot/wait): keep the cursor
        // present at its last spot, don't move it.
        controller.ensure(ctx.sessionId);
        if (debug) console.log(`[cu-overlay] ensure (no-coord ${action.type}) session=${ctx.sessionId.slice(0, 8)}`);
        return;
      }
      const screenPt = declaredPxToScreenPoint(pt, screen.getPrimaryDisplay());
      if (debug) {
        const d = screen.getPrimaryDisplay();
        console.log(`[cu-overlay] move ${action.type} declared=(${pt.x},${pt.y}) → screen=(${Math.round(screenPt.x)},${Math.round(screenPt.y)}) scale=${d.scaleFactor} kind=${kindOf(action)}`);
      }
      controller.move({
        actionId: ctx.toolCallId,
        sessionId: ctx.sessionId,
        screenX: screenPt.x,
        screenY: screenPt.y,
        kind: kindOf(action),
      });
    },
  };
}
