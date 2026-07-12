import type { CuAction } from '@maka/core';
import type { CuFrameAdapter, CuScreenshot } from '@maka/runtime';

const MINIMAX_MODEL_LONG_EDGE_PX = 1280;

export interface MiniMaxComputerFrameTransform {
  source: { widthPx: number; heightPx: number };
  model: { widthPx: number; heightPx: number };
}

export interface MiniMaxComputerHarnessOptions {
  resolveCaptureDisplay: () => { widthPx: number; heightPx: number };
  resizeFrame: (
    screenshot: CuScreenshot,
    target: { widthPx: number; heightPx: number },
  ) => CuScreenshot;
}

function requireDisplaySize(
  display: { widthPx: number; heightPx: number },
): { widthPx: number; heightPx: number } {
  if (
    !Number.isFinite(display.widthPx)
    || !Number.isFinite(display.heightPx)
    || display.widthPx <= 0
    || display.heightPx <= 0
  ) {
    throw new Error('MiniMax Computer Use requires a positive finite capture display size');
  }
  return display;
}

export function minimaxComputerFrameTransform(
  sourceDisplay: { widthPx: number; heightPx: number },
): MiniMaxComputerFrameTransform {
  const source = requireDisplaySize(sourceDisplay);
  const scale = Math.min(1, MINIMAX_MODEL_LONG_EDGE_PX / Math.max(source.widthPx, source.heightPx));
  return {
    source,
    model: {
      widthPx: Math.max(1, Math.round(source.widthPx * scale)),
      heightPx: Math.max(1, Math.round(source.heightPx * scale)),
    },
  };
}

export function minimaxModelPointToSource(
  point: { x: number; y: number },
  transform: MiniMaxComputerFrameTransform,
): { x: number; y: number } {
  const { source, model } = transform;
  return {
    x: Math.max(0, Math.min(Math.round(point.x * source.widthPx / model.widthPx), source.widthPx - 1)),
    y: Math.max(0, Math.min(Math.round(point.y * source.heightPx / model.heightPx), source.heightPx - 1)),
  };
}

function toSourceAction(action: CuAction, transform: MiniMaxComputerFrameTransform): CuAction {
  const mapPoint = (point: { x: number; y: number }) =>
    minimaxModelPointToSource(point, transform);

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
      return { ...action, coordinate: mapPoint(action.coordinate) };
    case 'left_click_drag':
      return {
        ...action,
        startCoordinate: mapPoint(action.startCoordinate),
        coordinate: mapPoint(action.coordinate),
      };
    case 'zoom': {
      const topLeft = mapPoint({ x: action.region.x1, y: action.region.y1 });
      const bottomRight = mapPoint({ x: action.region.x2, y: action.region.y2 });
      return {
        ...action,
        region: { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y },
      };
    }
    default:
      return action;
  }
}

/**
 * MiniMax-M3 uses the normal client-side `computer` function tool. This
 * adapter only fixes the image frame presented to the model and maps model
 * coordinates back into the source capture.
 */
export function createMiniMaxComputerHarness(
  options: MiniMaxComputerHarnessOptions,
): CuFrameAdapter {
  const resolveTransform = () =>
    minimaxComputerFrameTransform(options.resolveCaptureDisplay());

  return {
    resolveModelDisplay: () => resolveTransform().model,
    toSourceAction(action) {
      return toSourceAction(action, resolveTransform());
    },
    prepareScreenshot(screenshot) {
      const transform = resolveTransform();
      if (
        screenshot.widthPx !== transform.source.widthPx
        || screenshot.heightPx !== transform.source.heightPx
      ) {
        return screenshot;
      }
      if (
        screenshot.widthPx === transform.model.widthPx
        && screenshot.heightPx === transform.model.heightPx
      ) {
        return screenshot;
      }
      return options.resizeFrame(screenshot, transform.model);
    },
  };
}
