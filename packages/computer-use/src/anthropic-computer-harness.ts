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
  return {
    x: Math.max(0, Math.min(Math.round(point.x * source.widthPx / model.widthPx), source.widthPx - 1)),
    y: Math.max(0, Math.min(Math.round(point.y * source.heightPx / model.heightPx), source.heightPx - 1)),
  };
}

export function createAnthropicComputerHarness(
  options: AnthropicComputerHarnessOptions,
): CuFrameAdapter {
  const displays = () => {
    const source = options.resolveCaptureDisplay();
    return { source, model: anthropicComputerImageSize(source.widthPx, source.heightPx) };
  };
  return {
    resolveModelDisplay: () => displays().model,
    toSourceAction(action) {
      const { source, model } = displays();
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
      const { source, model } = displays();
      if (screenshot.widthPx !== source.widthPx || screenshot.heightPx !== source.heightPx) {
        // Zoom results are cropped detail frames, not the full display contract.
        return screenshot;
      }
      return options.resizeFrame(screenshot, model);
    },
  };
}
