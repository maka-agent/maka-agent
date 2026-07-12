export { SandboxManager } from './sandbox-manager.js';
export { createDefaultSandboxManager } from './default-sandbox-manager.js';
export {
  createPermissionAwareSandboxContext,
  deriveFilesystemWorkerProfile,
} from './permission-aware-context.js';
export { createSessionSandboxContextProvider } from './session-context-provider.js';
export {
  createExternalSandboxCapabilities,
  probeActiveSandboxCapabilities,
  sandboxContextForTool,
} from './active-capabilities.js';
export {
  sandboxErrorMetadata,
  serializeSandboxError,
} from './errors.js';
export type {
  CreatePermissionAwareSandboxContextInput,
  FilesystemWorkerProfileOperation,
  PermissionAwareSandboxContext,
  PermissionAwareSandboxContextAssembly,
} from './permission-aware-context.js';
export type {
  CreateSessionSandboxContextProviderInput,
  SandboxSessionHeader,
} from './session-context-provider.js';
export type {
  ActiveSandboxCapabilities,
  ActiveSandboxCapability,
  ProbeActiveSandboxCapabilitiesInput,
  SandboxCapabilityUnavailableReason,
} from './active-capabilities.js';
export type {
  SandboxErrorDomain,
  SandboxErrorMetadata,
  SandboxErrorStage,
  SandboxErrorWithMetadata,
} from './errors.js';
export {
  MACOS_SEATBELT_BASE_POLICY,
  MACOS_SEATBELT_EXECUTABLE,
  MACOS_SEATBELT_PLATFORM_DEFAULTS_POLICY,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
} from './macos-seatbelt.js';
export type {
  BuildSeatbeltPolicyInput,
  BuildSeatbeltPolicyResult,
  CreateSeatbeltExecArgsInput,
} from './macos-seatbelt.js';
export type {
  SandboxBackend,
  SandboxCommand,
  SandboxExecRequest,
  SandboxPathContext,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionReason,
  SandboxSelectionResult,
  SandboxTransformFailureReason,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './types.js';
