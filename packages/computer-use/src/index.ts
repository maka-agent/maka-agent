// @maka/computer-use — the shared, node-only computer-use backend + coordinate/
// overlay seam, usable by BOTH the desktop GUI (apps/desktop, which adds the
// Electron overlay window) and the CLI (packages/cli, headless). The `computer`
// TOOL itself lives in @maka/runtime; this package is the host dispatch (cua-driver),
// binary resolution, and the CuAction→cursor overlay hook.
export { selectComputerUseBackend } from './select-backend.js';
export type { CuBackendId, SelectedComputerUseBackend } from './select-backend.js';

export { createCuaDriverBackend } from './cua-driver-backend.js';
export type { CuaDriverBackendOptions, CuaDriverTraceEvent } from './cua-driver-backend.js';
export { normalizeCuaDriverOutcome } from './cua-driver-result.js';
export type { JsonRpcToolResult } from './cua-driver-result.js';
export { resolveCuaPageTextTarget } from './cua-driver-page-target.js';
export type {
  CuaCdpPageTarget,
  CuaFocusedPageElement,
  CuaPageTargetResolverDeps,
  CuaResolvedPageTextTarget,
  CuaSemanticPointerAction,
  CuaSemanticPointerResult,
} from './cua-driver-page-target.js';
export {
  CUA_INSPECT_PREPARED_ELEMENT_SCRIPT,
  buildCuaPrepareElementAtScreenPointScript,
  buildCuaSemanticPointerActionScript,
  parseCuaFocusedPageElement,
  parseCuaSemanticPointerResult,
} from './cua-driver-page-target.js';
export {
  editableElementAtScreenPoint,
  elementAtScreenPoint,
  resolveWindowAtDeclaredPoint,
  windowPointFromSnapshot,
} from './cua-driver-snapshot.js';
export type {
  CuaResolvedWindow,
  CuaSnapshotElement,
  CuaWindowBounds,
  CuaWindowRecord,
} from './cua-driver-snapshot.js';

export { cuaDriverBinaryPath, resolveCuaDriverBinaryPath } from './cua-driver-path.js';

export { createComputerUseOverlayHook, declaredPxToScreenPoint } from './computer-use-overlay-hook.js';
export {
  createMiniMaxComputerHarness,
  minimaxComputerFrameTransform,
  minimaxModelPointToSource,
} from './minimax-computer-harness.js';
export type {
  MiniMaxComputerFrameTransform,
  MiniMaxComputerHarnessOptions,
} from './minimax-computer-harness.js';
export type {
  CursorActionKind,
  CursorCompleteInput,
  CursorMoveInput,
  OverlayCursorSink,
  OverlayScreenLike,
} from './computer-use-overlay-hook.js';
