import type { CuAction } from '@maka/core';
import type { CuFrameAdapter, CuScreenshot } from '@maka/runtime';

const PATCH_SIZE_PX = 28;
const MAX_EDGE_PX = 1568;
const MAX_PATCHES = 1568;

export interface AnthropicComputerHarnessOptions {
  resolveCaptureDisplay: () => { widthPx: number; heightPx: number };
  resizeFrame: (
    screenshot: CuScreenshot,
    target: { widthPx: number; heightPx: number },
  ) => CuScreenshot;
}

function patchesForDimension(px: number): number {
  return Math.floor((px - 1) / PATCH_SIZE_PX) + 1;
}

function fitsAnthropicVision(widthPx: number, heightPx: number): boolean {
  return widthPx <= MAX_EDGE_PX
    && heightPx <= MAX_EDGE_PX
    && patchesForDimension(widthPx) * patchesForDimension(heightPx) <= MAX_PATCHES;
}

/** Port of Anthropic's reference target_image_size algorithm. */
export function anthropicComputerImageSize(
  widthPx: number,
  heightPx: number,
): { widthPx: number; heightPx: number } {
  if (fitsAnthropicVision(widthPx, heightPx)) return { widthPx, heightPx };
  if (heightPx > widthPx) {
    const transposed = anthropicComputerImageSize(heightPx, widthPx);
    return { widthPx: transposed.heightPx, heightPx: transposed.widthPx };
  }
  const aspect = widthPx / heightPx;
  let low = 1;
  let high = widthPx;
  while (low + 1 < high) {
    const candidateWidth = Math.floor((low + high) / 2);
    const candidateHeight = Math.max(Math.round(candidateWidth / aspect), 1);
    if (fitsAnthropicVision(candidateWidth, candidateHeight)) low = candidateWidth;
    else high = candidateWidth;
  }
  return {
    widthPx: low,
    heightPx: Math.max(Math.round(low / aspect), 1),
  };
}

function scalePoint(
  point: { x: number; y: number },
  source: { widthPx: number; heightPx: number },
  model: { widthPx: number; heightPx: number },
): { x: number; y: number } {
  if (
    !Number.isInteger(point.x)
    || !Number.isInteger(point.y)
    || point.x < 0
    || point.y < 0
    || point.x >= model.widthPx
    || point.y >= model.heightPx
  ) {
    throw new Error(
      `invalid_coordinate: Anthropic model point (${point.x},${point.y}) is outside `
      + `${model.widthPx}x${model.heightPx}`,
    );
  }
  return {
    x: Math.min(Math.round(point.x * source.widthPx / model.widthPx), source.widthPx - 1),
    y: Math.min(Math.round(point.y * source.heightPx / model.heightPx), source.heightPx - 1),
  };
}

export function createAnthropicComputerHarness(
  options: AnthropicComputerHarnessOptions,
): CuFrameAdapter {
  let currentTransform: {
    source: { widthPx: number; heightPx: number };
    model: { widthPx: number; heightPx: number };
  } | undefined;
  const resolveTransform = () => {
    const source = options.resolveCaptureDisplay();
    return { source, model: anthropicComputerImageSize(source.widthPx, source.heightPx) };
  };
  const declareTransform = () => {
    currentTransform = resolveTransform();
    return currentTransform;
  };
  return {
    resolveModelDisplay: () => declareTransform().model,
    toSourceAction(action) {
      const { source, model } = currentTransform ?? declareTransform();
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
          return { ...action, coordinate: scalePoint(action.coordinate, source, model) };
        case 'left_click_drag':
          return {
            ...action,
            startCoordinate: scalePoint(action.startCoordinate, source, model),
            coordinate: scalePoint(action.coordinate, source, model),
          };
        case 'zoom': {
          const topLeft = scalePoint({ x: action.region.x1, y: action.region.y1 }, source, model);
          const bottomRight = scalePoint({ x: action.region.x2, y: action.region.y2 }, source, model);
          return {
            ...action,
            region: { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y },
          };
        }
        default:
          return action;
      }
    },
    prepareScreenshot(screenshot) {
      const transform = resolveTransform();
      const { source, model } = transform;
      if (screenshot.widthPx !== source.widthPx || screenshot.heightPx !== source.heightPx) {
        // Zoom results are cropped detail frames, not the full display contract.
        return screenshot;
      }
      currentTransform = transform;
      return options.resizeFrame(screenshot, model);
    },
  };
}
