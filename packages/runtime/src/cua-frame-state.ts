import { randomUUID } from 'node:crypto';
import type { CuAction, CuPoint } from '@maka/core';

export interface CuaFrameIdentity {
  frameId: string;
  epoch: number;
}

export interface CuaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CuaDisplaySnapshot {
  displayId: string;
  logicalBounds: CuaRect;
  sourceBoundsPx: CuaRect;
  scaleFactor: number;
}

export interface CuaPageIdentity {
  cdpPort: number;
  pageTargetId: string;
  pageUrl: string;
  targetUrlContains: string;
  documentFingerprint?: string;
}

export interface CuaWindowIdentity {
  pid: number;
  windowId: number;
  bundleId?: string;
  appName?: string;
  title?: string;
  bounds?: CuaRect;
  sourceBoundsPx?: CuaRect;
  zIndex?: number;
  contentFingerprint?: string;
  page?: CuaPageIdentity;
}

export interface CuaObservationSnapshot {
  capturedAt: number;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  displays: CuaDisplaySnapshot[];
  windows: CuaWindowIdentity[];
}

export interface CuaObservation extends CuaFrameIdentity, CuaObservationSnapshot {}

export interface CuaBoundAction {
  frameId: string;
  epoch: number;
  actionFingerprint: string;
  fingerprint: string;
  target?: CuaWindowIdentity;
  display?: CuaDisplaySnapshot;
  elementId?: string;
  sourceCoordinate?: CuPoint;
  sourceStartCoordinate?: CuPoint;
  displayLogicalCoordinate?: CuPoint;
  displayLogicalStartCoordinate?: CuPoint;
  windowCoordinate?: CuPoint;
  windowStartCoordinate?: CuPoint;
  coordinateSpace?: 'window-screenshot-local';
}

export type CuaActionRejectionReason =
  | 'invalid_binding'
  | 'no_active_frame'
  | 'stale_epoch'
  | 'stale_frame'
  | 'duplicate_action'
  | 'action_not_claimed';

export type CuaActionClaimResult =
  | { ok: true }
  | { ok: false; reason: CuaActionRejectionReason };

export type CuaActionConfirmationResult =
  | { ok: true; epoch: number }
  | { ok: false; reason: CuaActionRejectionReason };

export type CuaFrameIdFactory = (epoch: number) => string;

export function bindCuaAction(
  frame: CuaFrameIdentity,
  actionFingerprint: string,
  binding: Omit<
    CuaBoundAction,
    keyof CuaFrameIdentity | 'actionFingerprint' | 'fingerprint'
  > = {},
): CuaBoundAction {
  return {
    ...frame,
    actionFingerprint,
    fingerprint: JSON.stringify([frame.frameId, frame.epoch, actionFingerprint]),
    ...binding,
  };
}

export class CuaFrameState {
  private epoch = 0;
  private currentFrame: CuaObservation | undefined;
  private readonly claimedActions = new Set<string>();
  private readonly consumedActions = new Set<string>();

  constructor(
    private readonly createFrameId: CuaFrameIdFactory = () => randomUUID(),
  ) {}

  observe(snapshot: CuaObservationSnapshot = {
    capturedAt: Date.now(),
    displays: [],
    windows: [],
  }): CuaObservation {
    const frame = {
      frameId: this.createFrameId(this.epoch),
      epoch: this.epoch,
      ...snapshot,
    };
    this.currentFrame = frame;
    this.claimedActions.clear();
    return frame;
  }

  activeObservation(): CuaObservation | undefined {
    return this.currentFrame;
  }

  invalidate(): number {
    this.epoch += 1;
    this.currentFrame = undefined;
    this.claimedActions.clear();
    return this.epoch;
  }

  claimAction(action: CuaBoundAction): CuaActionClaimResult {
    if (this.consumedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'duplicate_action' };
    }
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'duplicate_action' };
    }
    this.claimedActions.add(action.fingerprint);
    return { ok: true };
  }

  confirmAction(action: CuaBoundAction): CuaActionConfirmationResult {
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (!this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'action_not_claimed' };
    }
    this.consumedActions.add(action.fingerprint);
    return { ok: true, epoch: this.invalidate() };
  }

  isConsumed(frame: CuaFrameIdentity, actionFingerprint: string): boolean {
    return this.consumedActions.has(
      bindCuaAction(frame, actionFingerprint).fingerprint,
    );
  }

  private validateAction(action: CuaBoundAction): CuaActionRejectionReason | undefined {
    if (
      bindCuaAction(action, action.actionFingerprint).fingerprint
      !== action.fingerprint
    ) {
      return 'invalid_binding';
    }
    if (!this.currentFrame) return 'no_active_frame';
    if (action.epoch !== this.epoch) return 'stale_epoch';
    if (action.frameId !== this.currentFrame.frameId) return 'stale_frame';
    return undefined;
  }
}

function pointInside(point: CuPoint, rect: CuaRect): boolean {
  return point.x >= rect.x
    && point.x < rect.x + rect.width
    && point.y >= rect.y
    && point.y < rect.y + rect.height;
}

function bindWindowLocalPoint(
  observation: CuaObservation,
  coordinate: CuPoint,
): {
  target: CuaWindowIdentity;
  windowCoordinate: CuPoint;
} | undefined {
  if (observation.windows.length !== 1) return undefined;
  const target = observation.windows[0];
  const screenshotBounds = {
    x: 0,
    y: 0,
    width: observation.screenshotWidthPx ?? target.sourceBoundsPx?.width ?? 0,
    height: observation.screenshotHeightPx ?? target.sourceBoundsPx?.height ?? 0,
  };
  if (
    screenshotBounds.width <= 0
    || screenshotBounds.height <= 0
    || !pointInside(coordinate, screenshotBounds)
  ) return undefined;
  return {
    target,
    windowCoordinate: coordinate,
  };
}

export function fingerprintCuaAction(action: CuAction): string {
  return JSON.stringify(action);
}

export function fingerprintCuaSemanticAction(
  type: string,
  elementId?: string,
  value?: string,
): string {
  return JSON.stringify([type, elementId, value]);
}

export function bindCuaSemanticActionToObservation(
  observation: CuaObservation,
  input: { type: string; elementId?: string; value?: string },
): CuaBoundAction | undefined {
  if (observation.windows.length !== 1) return undefined;
  return bindCuaAction(
    observation,
    fingerprintCuaSemanticAction(input.type, input.elementId, input.value),
    {
      target: observation.windows[0],
      ...(input.elementId ? { elementId: input.elementId } : {}),
    },
  );
}

export function bindCuaActionToObservation(
  observation: CuaObservation,
  action: CuAction,
): CuaBoundAction | undefined {
  const actionFingerprint = fingerprintCuaAction(action);
  const base = bindCuaAction(observation, actionFingerprint);
  if (action.type === 'zoom') {
    const start = bindWindowLocalPoint(observation, {
      x: Math.min(action.region.x1, action.region.x2),
      y: Math.min(action.region.y1, action.region.y2),
    });
    const end = bindWindowLocalPoint(observation, {
      x: Math.max(action.region.x1, action.region.x2),
      y: Math.max(action.region.y1, action.region.y2),
    });
    if (
      !start
      || !end
      || start.target.pid !== end.target.pid
      || start.target.windowId !== end.target.windowId
    ) return undefined;
    return {
      ...base,
      target: end.target,
      sourceStartCoordinate: {
        x: Math.min(action.region.x1, action.region.x2),
        y: Math.min(action.region.y1, action.region.y2),
      },
      sourceCoordinate: {
        x: Math.max(action.region.x1, action.region.x2),
        y: Math.max(action.region.y1, action.region.y2),
      },
      windowStartCoordinate: start.windowCoordinate,
      windowCoordinate: end.windowCoordinate,
      coordinateSpace: 'window-screenshot-local',
    };
  }
  if ('coordinate' in action) {
    const end = bindWindowLocalPoint(observation, action.coordinate);
    if (!end) return undefined;
    if (action.type === 'left_click_drag') {
      const start = bindWindowLocalPoint(observation, action.startCoordinate);
      if (
        !start
        || start.target.pid !== end.target.pid
        || start.target.windowId !== end.target.windowId
      ) return undefined;
      return {
        ...base,
        target: end.target,
        sourceCoordinate: action.coordinate,
        sourceStartCoordinate: action.startCoordinate,
        windowCoordinate: end.windowCoordinate,
        windowStartCoordinate: start.windowCoordinate,
        coordinateSpace: 'window-screenshot-local',
      };
    }
    return {
      ...base,
      target: end.target,
      sourceCoordinate: action.coordinate,
      windowCoordinate: end.windowCoordinate,
      coordinateSpace: 'window-screenshot-local',
    };
  }
  return base;
}
