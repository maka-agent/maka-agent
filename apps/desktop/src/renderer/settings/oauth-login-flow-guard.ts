// Framework-free primitives behind useOAuthLoginFlow's async safety. Kept in a
// React-free module so their behavior is unit-testable without a DOM (see
// oauth-login-flow-guard.test.ts) and so the desktop test runner can import
// them without pulling React into its program.

// Synchronous one-shot action guard: rejects a second concurrent action before
// React can re-render the disabled button. A plain closure (held in a ref by
// the hook) so the check is synchronous, not subject to render batching.
export interface OneShotActionGuard<Action> {
  begin(action: Action): boolean;
  finish(): void;
  readonly current: Action | null;
}

export function createOneShotActionGuard<Action>(): OneShotActionGuard<Action> {
  let current: Action | null = null;
  return {
    begin(action: Action): boolean {
      if (current !== null) return false;
      current = action;
      return true;
    },
    finish(): void {
      current = null;
    },
    get current(): Action | null {
      return current;
    },
  };
}

// Cancel-on-unmount primitive: cancels a still-pending authorization request
// and clears the holder so a late resolution cannot re-cancel it. No-ops when
// nothing is pending.
export function teardownPendingAuthorization(
  holder: { current: string | null },
  cancelAuthorization: (authRequestId: string) => void,
): void {
  const pendingAuthRequestId = holder.current;
  holder.current = null;
  if (pendingAuthRequestId) cancelAuthorization(pendingAuthRequestId);
}
