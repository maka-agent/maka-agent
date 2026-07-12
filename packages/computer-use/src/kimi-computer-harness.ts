import type { CuAction } from '@maka/core';
import type { CuFrameAdapter, CuScreenshot } from '@maka/runtime';

const KIMI_MAX_WIDTH_PX = 4096;
const KIMI_MAX_HEIGHT_PX = 2160;

export interface KimiComputerHarnessOptions {
  resolveCaptureDisplay: () => { widthPx: number; heightPx: number };
  resizeFrame: (
    screenshot: CuScreenshot,
    target: { widthPx: number; heightPx: number },
  ) => CuScreenshot;
}

export function kimiComputerImageSize(
  widthPx: number,
  heightPx: number,
): { widthPx: number; heightPx: number } {
  const scale = Math.min(
    1,
    KIMI_MAX_WIDTH_PX / widthPx,
    KIMI_MAX_HEIGHT_PX / heightPx,
  );
  return {
    widthPx: Math.max(1, Math.round(widthPx * scale)),
    heightPx: Math.max(1, Math.round(heightPx * scale)),
  };
}

function mapPoint(
  point: { x: number; y: number },
  source: { widthPx: number; heightPx: number },
  model: { widthPx: number; heightPx: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(Math.round(point.x * source.widthPx / model.widthPx), source.widthPx - 1)),
    y: Math.max(0, Math.min(Math.round(point.y * source.heightPx / model.heightPx), source.heightPx - 1)),
  };
}

export function createKimiComputerHarness(options: KimiComputerHarnessOptions): CuFrameAdapter {
  const frames = () => {
    const source = options.resolveCaptureDisplay();
    return { source, model: kimiComputerImageSize(source.widthPx, source.heightPx) };
  };
  return {
    resolveModelDisplay: () => frames().model,
    toSourceAction(action) {
      const { source, model } = frames();
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
          return { ...action, coordinate: mapPoint(action.coordinate, source, model) };
        case 'left_click_drag':
          return {
            ...action,
            startCoordinate: mapPoint(action.startCoordinate, source, model),
            coordinate: mapPoint(action.coordinate, source, model),
          };
        case 'zoom': {
          const topLeft = mapPoint({ x: action.region.x1, y: action.region.y1 }, source, model);
          const bottomRight = mapPoint({ x: action.region.x2, y: action.region.y2 }, source, model);
          return { ...action, region: { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y } };
        }
        default:
          return action;
      }
    },
    prepareScreenshot(screenshot) {
      const { source, model } = frames();
      if (screenshot.widthPx !== source.widthPx || screenshot.heightPx !== source.heightPx) return screenshot;
      return source.widthPx === model.widthPx && source.heightPx === model.heightPx
        ? screenshot
        : options.resizeFrame(screenshot, model);
    },
  };
}
