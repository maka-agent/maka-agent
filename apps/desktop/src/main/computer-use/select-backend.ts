// PR-DESKTOP-CU-SELECT — choose and construct the computer-use dispatch backend.
//
// The model-facing `computer` tool is only wired when a working backend exists.
// This selector fails CLOSED: on non-macOS, a missing binary, or ANY
// construction error it returns zero tools so the capability group stays
// unavailable and the app never crashes at startup.
//
// Backend choice: MAKA_CU_BACKEND selects 'cua-driver' (default, Tier-2
// coordinate-background) or 'ax-helper' (Tier-1 signed Swift helper). The
// runtime's `computer` tool owns the OS-independent Path 18 duties (S12 TCC
// re-check, S17 typed errors, S18 abort); the backend only marshals dispatch.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildComputerUseTools, type CuDispatchBackend, type CuOverlayHook } from '@maka/runtime';
import { createHelperBackend } from './helper-backend.js';
import { createCuaDriverBackend } from './cua-driver-backend.js';
import { resolveCuaDriverBinaryPath } from './cua-driver-path.js';

export type CuBackendId = 'cua-driver' | 'ax-helper';

/** A backend that may or may not own a disposable child process. */
type DisposableBackend = CuDispatchBackend & { dispose?: () => void };

export interface SelectedComputerUseBackend {
  /** The constructed backend, or undefined when the feature is unavailable. */
  backend?: DisposableBackend;
  /** The `computer` tool(s) — empty when unavailable (fail closed). */
  tools: ReturnType<typeof buildComputerUseTools>;
  /** Which backend was chosen, or 'none' when unavailable. */
  backendId: CuBackendId | 'none';
}

const NONE: SelectedComputerUseBackend = { backend: undefined, tools: [], backendId: 'none' };

// --- Binary path resolvers -------------------------------------------------
// The cua-driver path comes from cua-driver-path.ts (packaged <Resources>/bin,
// dev-repo fallback) so there is ONE source of truth for where the binary lives.
// The ax-helper resolver below is still a stub — the signed Swift helper's
// packaging job lands its real resolver alongside the bundled binary. A path
// that does not exist makes the selector fail closed, which is the contract.
function getAxHelperBinaryPath(): string {
  const base = process.resourcesPath ?? process.cwd();
  return join(base, 'maka-cu-helper', 'maka-cu-helper');
}

/** The host app bundle id, for cua-driver's TCC responsibility-chain inherit. */
function resolveHostBundleId(explicit?: string): string {
  return explicit ?? process.env.MAKA_CU_HOST_BUNDLE_ID ?? 'com.maka.desktop';
}

function readBackendId(): CuBackendId {
  return process.env.MAKA_CU_BACKEND === 'ax-helper' ? 'ax-helper' : 'cua-driver';
}

/**
 * Pick + build the computer-use backend and its `computer` tool. Never throws:
 * any unmet precondition or construction failure returns the NONE sentinel so
 * the caller simply advertises no tools.
 */
export function selectComputerUseBackend(deps?: { hostBundleId?: string; overlay?: CuOverlayHook }): SelectedComputerUseBackend {
  // Fail closed off macOS — the whole capability is AX/ScreenCaptureKit-bound.
  if (process.platform !== 'darwin') return NONE;

  const overlay = deps?.overlay;
  try {
    const backendId = readBackendId();

    if (backendId === 'ax-helper') {
      const helperPath = getAxHelperBinaryPath();
      if (!existsSync(helperPath)) return NONE;
      const backend = createHelperBackend({ helperPath });
      return { backend, tools: buildComputerUseTools({ backend, overlay }), backendId };
    }

    // Default: cua-driver (Tier-2 coordinate-background).
    const binaryPath = resolveCuaDriverBinaryPath();
    if (!binaryPath) return NONE;
    const backend = createCuaDriverBackend({
      binaryPath,
      hostBundleId: resolveHostBundleId(deps?.hostBundleId),
    });
    return { backend, tools: buildComputerUseTools({ backend, overlay }), backendId };
  } catch (err) {
    // Fail closed → feature unavailable, never crash startup. Log so a genuine
    // construction bug (broken import, throwing resolver) is distinguishable
    // from the legitimate "binary not present" path, which returns NONE above
    // without reaching here.
    console.warn('[computer-use] backend construction failed; feature unavailable:', err);
    return NONE;
  }
}
