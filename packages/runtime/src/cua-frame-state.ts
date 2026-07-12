import { randomUUID } from 'node:crypto';

export interface CuaFrameIdentity {
  frameId: string;
  epoch: number;
}

export interface CuaBoundAction {
  frameId: string;
  epoch: number;
  actionFingerprint: string;
  fingerprint: string;
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
): CuaBoundAction {
  return {
    ...frame,
    actionFingerprint,
    fingerprint: JSON.stringify([frame.frameId, actionFingerprint]),
  };
}

export class CuaFrameState {
  private epoch = 0;
  private currentFrame: CuaFrameIdentity | undefined;
  private readonly claimedActions = new Set<string>();

  constructor(
    private readonly createFrameId: CuaFrameIdFactory = () => randomUUID(),
  ) {}

  observe(): CuaFrameIdentity {
    const frame = {
      frameId: this.createFrameId(this.epoch),
      epoch: this.epoch,
    };
    this.currentFrame = frame;
    this.claimedActions.clear();
    return frame;
  }

  invalidate(): number {
    this.epoch += 1;
    this.currentFrame = undefined;
    this.claimedActions.clear();
    return this.epoch;
  }

  claimAction(action: CuaBoundAction): CuaActionClaimResult {
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
    return { ok: true, epoch: this.invalidate() };
  }

  private validateAction(action: CuaBoundAction): CuaActionRejectionReason | undefined {
    if (bindCuaAction(action, action.actionFingerprint).fingerprint !== action.fingerprint) {
      return 'invalid_binding';
    }
    if (!this.currentFrame) return 'no_active_frame';
    if (action.epoch !== this.epoch) return 'stale_epoch';
    if (action.frameId !== this.currentFrame.frameId) return 'stale_frame';
    return undefined;
  }
}
