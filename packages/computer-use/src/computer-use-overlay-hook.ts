import type { CuAction, CuPoint } from '@maka/core';
import type { CuOverlayHook, CuPresentationFence } from '@maka/runtime';

export type CursorActionKind = 'move' | 'click' | 'drag' | 'scroll';

export interface CursorMoveInput {
  actionId: string;
  sessionId: string;
  screenX: number;
  screenY: number;
  kind: CursorActionKind;
  pressed?: boolean;
  instant?: boolean;
}

export interface CursorCompleteInput extends CursorMoveInput {
  pulse: boolean;
}

export interface CursorCancelInput {
  actionId: string;
  sessionId: string;
}

export interface OverlayCursorSink {
  ensure(sessionId: string): void;
  move(input: CursorMoveInput): CuPresentationFence | void;
  complete(input: CursorCompleteInput): void;
  cancel(input: CursorCancelInput): void;
}

const RESOLVED_PRESENTATION_FENCE: CuPresentationFence = {
  readyForInteraction: Promise.resolve(),
  finished: Promise.resolve(),
};

function beginCoordinateOf(action: CuAction): CuPoint | undefined {
  switch (action.type) {
    case 'left_click_drag':
      return action.startCoordinate;
    case 'mouse_move':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'scroll':
      return action.coordinate;
    default:
      return undefined;
  }
}

function endCoordinateOf(action: CuAction): CuPoint | undefined {
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
      return undefined;
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

export function createComputerUseOverlayHook(controller: OverlayCursorSink): CuOverlayHook {
  return {
    onActionBegin(action, context) {
      const declaredPoint = beginCoordinateOf(action);
      const screenPoint = context.presentationScreenPoint;
      if (!declaredPoint || !screenPoint) {
        controller.ensure(context.sessionId);
        return RESOLVED_PRESENTATION_FENCE;
      }
      return controller.move({
        actionId: context.toolCallId,
        sessionId: context.sessionId,
        screenX: screenPoint.x,
        screenY: screenPoint.y,
        kind: kindOf(action),
        instant: action.type !== 'mouse_move',
      });
    },
    onActionEnd(action, result, context) {
      if (!endCoordinateOf(action)) return;
      if (!result?.outcome.ok) {
        controller.cancel({
          actionId: context.toolCallId,
          sessionId: context.sessionId,
        });
        return;
      }
      const screenPoint = result?.resolvedScreenPoint;
      if (!screenPoint) {
        controller.cancel({
          actionId: context.toolCallId,
          sessionId: context.sessionId,
        });
        return;
      }
      const kind = kindOf(action);
      controller.complete({
        actionId: context.toolCallId,
        sessionId: context.sessionId,
        screenX: screenPoint.x,
        screenY: screenPoint.y,
        kind,
        pulse: result.outcome.ok && (kind === 'click' || kind === 'drag'),
      });
    },
  };
}
