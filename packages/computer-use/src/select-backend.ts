// PR-DESKTOP-CU-SELECT — construct the computer-use dispatch backend.
//
// The model-facing `computer` tool is only wired when a working backend exists.
// This selector fails CLOSED: on non-macOS, a missing binary, or ANY
// construction error it returns zero tools so the capability group stays
// unavailable and the app never crashes at startup.
//
// There is ONE backend: cua-driver (Tier-2 coordinate-background, trycua/cua-driver
// MIT). The runtime's `computer` tool owns the OS-independent Path 18 duties (S12 TCC
// re-check, S17 typed errors, S18 abort); the backend only marshals dispatch.
import {
  buildComputerUseTools,
  type CuDispatchBackend,
  type CuFrameAdapter,
  type CuOverlayHook,
} from '@maka/runtime';
import { createCuaDriverBackend } from './cua-driver-backend.js';
import { resolveCuaDriverBinaryPath } from './cua-driver-path.js';

export type CuBackendId = 'cua-driver';

/** A backend that may or may not own a disposable child process. */
type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
};

export interface SelectedComputerUseBackend {
  /** The constructed backend, or undefined when the feature is unavailable. */
  backend?: DisposableBackend;
  /** The `computer` tool(s) — empty when unavailable (fail closed). */
  tools: ReturnType<typeof buildComputerUseTools>;
  createTools: (frameAdapter?: CuFrameAdapter) => ReturnType<typeof buildComputerUseTools>;
  /** Which backend was chosen, or 'none' when unavailable. */
  backendId: CuBackendId | 'none';
}

const NONE: SelectedComputerUseBackend = {
  backend: undefined,
  tools: [],
  createTools: () => [],
  backendId: 'none',
};

/** The host app bundle id, for cua-driver's TCC responsibility-chain inherit. */
function resolveHostBundleId(explicit?: string): string {
  return explicit ?? process.env.MAKA_CU_HOST_BUNDLE_ID ?? 'com.maka.desktop';
}

/**
 * Build the cua-driver backend and its `computer` tool. Never throws: any unmet
 * precondition or construction failure returns the NONE sentinel so the caller
 * simply advertises no tools. The cua-driver binary path is the single source of
 * truth from cua-driver-path.ts (packaged <Resources>/bin, dev-repo fallback); a
 * path that does not exist makes the selector fail closed, which is the contract.
 */
export function selectComputerUseBackend(deps?: {
  hostBundleId?: string;
  overlay?: CuOverlayHook;
  compressFrame?: (base64: string, mimeType: string) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
}): SelectedComputerUseBackend {
  // Fail closed off macOS — the whole capability is AX/ScreenCaptureKit-bound.
  if (process.platform !== 'darwin') return NONE;

  const overlay = deps?.overlay;
  try {
    const binaryPath = resolveCuaDriverBinaryPath();
    if (!binaryPath) return NONE;
    const backend = createCuaDriverBackend({
      binaryPath,
      hostBundleId: resolveHostBundleId(deps?.hostBundleId),
      ...(deps?.compressFrame ? { compressFrame: deps.compressFrame } : {}),
    });
    const createTools = (frameAdapter?: CuFrameAdapter) => buildComputerUseTools({
      backend,
      overlay,
      ...(frameAdapter ? { frameAdapter } : {}),
    });
    return {
      backend,
      tools: createTools(),
      createTools,
      backendId: 'cua-driver',
    };
  } catch (err) {
    // Fail closed → feature unavailable, never crash startup. Log so a genuine
    // construction bug (broken import, throwing resolver) is distinguishable
    // from the legitimate "binary not present" path, which returns NONE above
    // without reaching here.
    console.warn('[computer-use] backend construction failed; feature unavailable:', err);
    return NONE;
  }
}
