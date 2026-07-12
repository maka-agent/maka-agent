# Sandbox Manager Skeleton Implementation Plan

> Archived: the implementation landed in PR #631. This plan is retained only as historical execution context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime-layer `SandboxManager` skeleton that selects a platform sandbox and transforms argv-based commands without wiring it into current tool execution yet.

**Architecture:** `packages/runtime/src/sandbox/types.ts` defines the sandbox boundary types, while `packages/runtime/src/sandbox/sandbox-manager.ts` owns selection, fail-closed behavior, and backend delegation. Phase 3 keeps macOS backend behavior injectable with a fake backend in tests; Phase 4 will add the real macOS Seatbelt backend.

**Tech Stack:** TypeScript ESM, Node built-in test runner, `@maka/core` `PermissionProfile`, `@maka/runtime` package exports.

---

### File Structure

- Create: `packages/runtime/src/sandbox/types.ts`
  - Owns `SandboxType`, `SandboxablePreference`, `SandboxPathContext`, `SandboxCommand`, `SandboxExecRequest`, `SandboxTransformRequest`, `SandboxTransformResult`, `SandboxSelectionResult`, and `SandboxBackend`.
- Create: `packages/runtime/src/sandbox/sandbox-manager.ts`
  - Owns `SandboxManager`, `shouldSandbox()`, `selectInitial()`, and `transform()`.
- Create: `packages/runtime/src/sandbox/index.ts`
  - Re-exports sandbox manager and type surface.
- Create: `packages/runtime/src/__tests__/sandbox-manager.test.ts`
  - Verifies profile-based selection, preference overrides, platform failures, and backend delegation.
- Modify: `packages/runtime/src/index.ts`
  - Re-exports the sandbox public API from the runtime barrel.
- Modify: `packages/runtime/package.json`
  - Adds `./sandbox` subpath export.
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`
  - Marks Phase 3 tasks complete after implementation and tests pass.

### Task 1: Write Sandbox Manager Tests First

**Files:**
- Create: `packages/runtime/src/__tests__/sandbox-manager.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDangerFullAccessPermissionProfile,
  createExternalPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import { SandboxManager } from '../sandbox/sandbox-manager.js';
import type {
  SandboxBackend,
  SandboxTransformRequest,
  SandboxTransformResult,
} from '../sandbox/types.js';

class FakeMacosBackend implements SandboxBackend {
  readonly type = 'macos-seatbelt' as const;
  calls: SandboxTransformRequest[] = [];

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    this.calls.push(request);
    const { command } = request;
    return {
      ok: true,
      exec: {
        argv: ['/usr/bin/sandbox-exec', '--', command.program, ...command.args],
        cwd: command.cwd,
        env: command.env,
        sandboxType: 'macos-seatbelt',
        effectiveProfile: command.profile,
      },
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      preference: request.preference ?? 'auto',
    };
  }
}

function command(profile: PermissionProfile) {
  return {
    program: '/bin/zsh',
    args: ['-lc', 'echo ok'],
    cwd: '/repo',
    profile,
    pathContext: {
      workspaceRoots: ['/repo'],
      slashTmp: '/tmp',
    },
  };
}

describe('SandboxManager.shouldSandbox', () => {
  it('uses PermissionProfile under auto preference', () => {
    const manager = new SandboxManager();

    assert.equal(manager.shouldSandbox(createReadOnlyPermissionProfile(), 'auto'), true);
    assert.equal(manager.shouldSandbox(createWorkspaceWritePermissionProfile(), 'auto'), true);
    assert.equal(manager.shouldSandbox(createDangerFullAccessPermissionProfile(), 'auto'), false);
    assert.equal(manager.shouldSandbox(createExternalPermissionProfile(), 'auto'), false);
    assert.equal(manager.shouldSandbox({ type: 'disabled', name: 'disabled' }, 'auto'), false);
  });

  it('honors require and forbid preference overrides', () => {
    const manager = new SandboxManager();

    assert.equal(manager.shouldSandbox(createDangerFullAccessPermissionProfile(), 'require'), true);
    assert.equal(manager.shouldSandbox(createWorkspaceWritePermissionProfile(), 'forbid'), false);
  });
});

describe('SandboxManager.selectInitial', () => {
  it('selects macos-seatbelt on darwin when restricted profile needs sandbox and backend exists', () => {
    const manager = new SandboxManager([new FakeMacosBackend()]);

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.deepEqual(result, {
      ok: true,
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      reason: 'platform_sandbox_selected',
      platform: 'darwin',
      preference: 'auto',
    });
  });

  it('fails closed on darwin when sandbox is required but macOS backend is unavailable', () => {
    const manager = new SandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'backend_not_available');
      assert.equal(result.sandboxType, 'macos-seatbelt');
      assert.equal(result.platform, 'darwin');
    }
  });

  it('returns backend_not_implemented for linux restricted profiles in Phase 3', () => {
    const manager = new SandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'linux',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'backend_not_implemented');
      assert.equal(result.sandboxType, 'linux');
    }
  });

  it('returns unsupported_platform for win32 restricted profiles', () => {
    const manager = new SandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'win32',
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unsupported_platform');
  });

  it('selects none for danger-full-access, external, disabled, and forbid', () => {
    const manager = new SandboxManager();

    const danger = manager.selectInitial({
      profile: createDangerFullAccessPermissionProfile(),
      platform: 'darwin',
    });
    const external = manager.selectInitial({
      profile: createExternalPermissionProfile(),
      platform: 'darwin',
    });
    const disabled = manager.selectInitial({
      profile: { type: 'disabled', name: 'disabled' },
      platform: 'darwin',
    });
    const forbid = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      preference: 'forbid',
      platform: 'darwin',
    });

    assert.equal(danger.ok && danger.sandboxType, 'none');
    assert.equal(external.ok && external.sandboxType, 'none');
    assert.equal(disabled.ok && disabled.sandboxType, 'none');
    assert.equal(forbid.ok && forbid.sandboxType, 'none');
  });
});

describe('SandboxManager.transform', () => {
  it('returns raw argv when selected sandbox is none', () => {
    const manager = new SandboxManager();
    const profile = createDangerFullAccessPermissionProfile();

    const result = manager.transform({
      command: command(profile),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.exec.argv, ['/bin/zsh', '-lc', 'echo ok']);
      assert.equal(result.exec.cwd, '/repo');
      assert.equal(result.exec.sandboxType, 'none');
      assert.equal(result.exec.effectiveProfile, profile);
      assert.equal(result.requiresSandbox, false);
    }
  });

  it('delegates macos-seatbelt transform to the registered backend', () => {
    const backend = new FakeMacosBackend();
    const manager = new SandboxManager([backend]);
    const profile = createWorkspaceWritePermissionProfile();

    const result = manager.transform({
      command: command(profile),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    assert.equal(backend.calls.length, 1);
    if (result.ok) {
      assert.deepEqual(result.exec.argv, ['/usr/bin/sandbox-exec', '--', '/bin/zsh', '-lc', 'echo ok']);
      assert.equal(result.exec.sandboxType, 'macos-seatbelt');
    }
  });

  it('returns selection failure from transform without throwing', () => {
    const manager = new SandboxManager();

    const result = manager.transform({
      command: command(createWorkspaceWritePermissionProfile()),
      platform: 'linux',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'backend_not_implemented');
      assert.equal(result.effectiveProfile.type, 'managed');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `npm --workspace @maka/runtime test`

Expected: FAIL because `packages/runtime/src/sandbox/sandbox-manager.ts` and `packages/runtime/src/sandbox/types.ts` do not exist yet.

### Task 2: Define Sandbox Boundary Types

**Files:**
- Create: `packages/runtime/src/sandbox/types.ts`

- [ ] **Step 1: Add the type surface**

```ts
import type { PermissionProfile } from '@maka/core/permission-profile';

export const SANDBOX_TYPES = ['none', 'macos-seatbelt', 'linux'] as const;
export type SandboxType = typeof SANDBOX_TYPES[number];

export const SANDBOXABLE_PREFERENCES = ['auto', 'require', 'forbid'] as const;
export type SandboxablePreference = typeof SANDBOXABLE_PREFERENCES[number];

export type SandboxPlatform = NodeJS.Platform;

export type SandboxSelectionSuccessReason =
  | 'sandbox_not_required'
  | 'preference_forbid'
  | 'platform_sandbox_selected';

export type SandboxTransformFailureReason =
  | 'unsupported_platform'
  | 'backend_not_available'
  | 'backend_not_implemented'
  | 'sandbox_required'
  | 'invalid_request';

export interface SandboxPathContext {
  workspaceRoots: readonly string[];
  tmpdir?: string;
  slashTmp?: string;
  minimalRoots?: readonly string[];
}

export interface SandboxCommand {
  program: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  profile: PermissionProfile;
  pathContext: SandboxPathContext;
}

export interface SandboxExecRequest {
  argv: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  sandboxType: SandboxType;
  effectiveProfile: PermissionProfile;
}

export interface SandboxSelectionInput {
  profile: PermissionProfile;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
}

export type SandboxSelectionResult =
  | {
      ok: true;
      sandboxType: SandboxType;
      requiresSandbox: boolean;
      reason: SandboxSelectionSuccessReason;
      platform: SandboxPlatform;
      preference: SandboxablePreference;
    }
  | {
      ok: false;
      reason: SandboxTransformFailureReason;
      message: string;
      sandboxType?: SandboxType;
      requiresSandbox: true;
      platform: SandboxPlatform;
      preference: SandboxablePreference;
      effectiveProfile: PermissionProfile;
    };

export interface SandboxTransformRequest {
  command: SandboxCommand;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
}

export type SandboxTransformResult =
  | {
      ok: true;
      exec: SandboxExecRequest;
      sandboxType: SandboxType;
      requiresSandbox: boolean;
      preference: SandboxablePreference;
    }
  | {
      ok: false;
      reason: SandboxTransformFailureReason;
      message: string;
      sandboxType?: SandboxType;
      requiresSandbox: true;
      platform: SandboxPlatform;
      preference: SandboxablePreference;
      effectiveProfile: PermissionProfile;
    };

export interface SandboxBackend {
  readonly type: Exclude<SandboxType, 'none'>;
  transform(request: SandboxTransformRequest): SandboxTransformResult;
}
```

- [ ] **Step 2: Run tests to verify remaining red**

Run: `npm --workspace @maka/runtime test`

Expected: FAIL because `SandboxManager` is not implemented yet.

### Task 3: Implement SandboxManager Selection and Transform

**Files:**
- Create: `packages/runtime/src/sandbox/sandbox-manager.ts`

- [ ] **Step 1: Add manager implementation**

```ts
import type { PermissionProfile } from '@maka/core/permission-profile';
import type {
  SandboxBackend,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionResult,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './types.js';

const DEFAULT_SANDBOXABLE_PREFERENCE: SandboxablePreference = 'auto';

export class SandboxManager {
  private readonly backends: ReadonlyMap<SandboxType, SandboxBackend>;

  constructor(backends: readonly SandboxBackend[] = []) {
    const map = new Map<SandboxType, SandboxBackend>();
    for (const backend of backends) {
      map.set(backend.type, backend);
    }
    this.backends = map;
  }

  shouldSandbox(
    profile: PermissionProfile,
    preference: SandboxablePreference = DEFAULT_SANDBOXABLE_PREFERENCE,
    _platform?: SandboxPlatform,
  ): boolean {
    if (preference === 'require') return true;
    if (preference === 'forbid') return false;
    return profileRequiresPlatformSandbox(profile);
  }

  selectInitial(input: SandboxSelectionInput): SandboxSelectionResult {
    const preference = input.preference ?? DEFAULT_SANDBOXABLE_PREFERENCE;
    const platform = input.platform ?? process.platform;
    const requiresSandbox = this.shouldSandbox(input.profile, preference, platform);

    if (!requiresSandbox) {
      return {
        ok: true,
        sandboxType: 'none',
        requiresSandbox: false,
        reason: preference === 'forbid' ? 'preference_forbid' : 'sandbox_not_required',
        platform,
        preference,
      };
    }

    if (platform === 'darwin') {
      if (!this.backends.has('macos-seatbelt')) {
        return sandboxSelectionFailure({
          reason: 'backend_not_available',
          message: 'macOS Seatbelt sandbox is required but no macOS sandbox backend is registered.',
          sandboxType: 'macos-seatbelt',
          platform,
          preference,
          profile: input.profile,
        });
      }
      return {
        ok: true,
        sandboxType: 'macos-seatbelt',
        requiresSandbox: true,
        reason: 'platform_sandbox_selected',
        platform,
        preference,
      };
    }

    if (platform === 'linux') {
      return sandboxSelectionFailure({
        reason: 'backend_not_implemented',
        message: 'Linux sandbox backend is not implemented in this phase.',
        sandboxType: 'linux',
        platform,
        preference,
        profile: input.profile,
      });
    }

    return sandboxSelectionFailure({
      reason: 'unsupported_platform',
      message: `Sandbox enforcement is not supported on platform ${platform}.`,
      platform,
      preference,
      profile: input.profile,
    });
  }

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const selection = this.selectInitial({
      profile: request.command.profile,
      preference: request.preference,
      platform: request.platform,
    });

    if (!selection.ok) return selection;

    if (selection.sandboxType === 'none') {
      return {
        ok: true,
        exec: {
          argv: [request.command.program, ...request.command.args],
          cwd: request.command.cwd,
          env: request.command.env,
          sandboxType: 'none',
          effectiveProfile: request.command.profile,
        },
        sandboxType: 'none',
        requiresSandbox: selection.requiresSandbox,
        preference: selection.preference,
      };
    }

    const backend = this.backends.get(selection.sandboxType);
    if (!backend) {
      return {
        ok: false,
        reason: 'backend_not_available',
        message: `Sandbox backend ${selection.sandboxType} is not registered.`,
        sandboxType: selection.sandboxType,
        requiresSandbox: true,
        platform: selection.platform,
        preference: selection.preference,
        effectiveProfile: request.command.profile,
      };
    }

    return backend.transform({
      ...request,
      preference: selection.preference,
      platform: selection.platform,
    });
  }
}

function profileRequiresPlatformSandbox(profile: PermissionProfile): boolean {
  if (profile.type === 'disabled') return false;
  if (profile.type === 'external') return false;
  if (profile.fileSystem.kind === 'restricted') return true;
  if (profile.network.kind === 'restricted') return true;
  return false;
}

function sandboxSelectionFailure(input: {
  reason:
    | 'unsupported_platform'
    | 'backend_not_available'
    | 'backend_not_implemented'
    | 'sandbox_required'
    | 'invalid_request';
  message: string;
  sandboxType?: SandboxType;
  platform: SandboxPlatform;
  preference: SandboxablePreference;
  profile: PermissionProfile;
}): Extract<SandboxSelectionResult, { ok: false }> {
  return {
    ok: false,
    reason: input.reason,
    message: input.message,
    sandboxType: input.sandboxType,
    requiresSandbox: true,
    platform: input.platform,
    preference: input.preference,
    effectiveProfile: input.profile,
  };
}
```

- [ ] **Step 2: Run tests to verify green**

Run: `npm --workspace @maka/runtime test`

Expected: PASS for `sandbox-manager.test.js`.

### Task 4: Export Sandbox API

**Files:**
- Create: `packages/runtime/src/sandbox/index.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/package.json`

- [ ] **Step 1: Add sandbox index exports**

```ts
export { SandboxManager } from './sandbox-manager.js';
export type {
  SandboxBackend,
  SandboxCommand,
  SandboxExecRequest,
  SandboxPathContext,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionResult,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './types.js';
export {
  SANDBOX_TYPES,
  SANDBOXABLE_PREFERENCES,
} from './types.js';
```

- [ ] **Step 2: Add runtime barrel exports**

Add to `packages/runtime/src/index.ts` near the other runtime boundary exports:

```ts
export { SandboxManager } from './sandbox/index.js';
export type {
  SandboxBackend,
  SandboxCommand,
  SandboxExecRequest,
  SandboxPathContext,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionResult,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './sandbox/index.js';
export {
  SANDBOX_TYPES,
  SANDBOXABLE_PREFERENCES,
} from './sandbox/index.js';
```

- [ ] **Step 3: Add package subpath export**

Add to `packages/runtime/package.json` exports:

```json
"./sandbox": "./dist/sandbox/index.js"
```

- [ ] **Step 4: Run tests**

Run: `npm --workspace @maka/runtime test`

Expected: PASS.

### Task 5: Update Phase 3 Todo and Verify

**Files:**
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`

- [ ] **Step 1: Mark Phase 3 checklist items complete**

Change each Phase 3 task checkbox from `[ ]` to `[x]` after implementation and tests pass.

- [ ] **Step 2: Run runtime test suite**

Run: `npm --workspace @maka/runtime test`

Expected: PASS.

- [ ] **Step 3: Review git diff**

Run: `git diff -- packages/runtime/src/sandbox/types.ts packages/runtime/src/sandbox/sandbox-manager.ts packages/runtime/src/sandbox/index.ts packages/runtime/src/__tests__/sandbox-manager.test.ts packages/runtime/src/index.ts packages/runtime/package.json docs/sandbox/agent-runtime-codex-sandbox-todo.md docs/superpowers/plans/2026-07-07-sandbox-manager-skeleton.md`

Expected: Diff only contains Phase 3 sandbox manager skeleton, tests, exports, and planned todo updates.

- [ ] **Step 4: Commit Phase 3**

```bash
git add \
  packages/runtime/src/sandbox/types.ts \
  packages/runtime/src/sandbox/sandbox-manager.ts \
  packages/runtime/src/sandbox/index.ts \
  packages/runtime/src/__tests__/sandbox-manager.test.ts \
  packages/runtime/src/index.ts \
  packages/runtime/package.json \
  docs/sandbox/agent-runtime-codex-sandbox-todo.md \
  docs/superpowers/plans/2026-07-07-sandbox-manager-skeleton.md
git commit -m "feat(runtime): add sandbox manager skeleton"
```

### Self-Review

- Spec coverage: The plan covers `SandboxType`, `SandboxablePreference`, argv-based command shape, transform result union, backend injection, macOS selection, Linux stub behavior, Windows unsupported behavior, `disabled` / unrestricted / external / `forbid` selecting `none`, and fail-closed behavior when sandbox is required but unavailable.
- Placeholder scan: No placeholder implementation steps are left.
- Type consistency: The tests and implementation use the same `SandboxManager`, `SandboxBackend`, `SandboxTransformRequest`, `SandboxTransformResult`, `SandboxType`, and `SandboxablePreference` names.
