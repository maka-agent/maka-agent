# Permission Profile Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure core-layer compiler that maps Maka `PermissionMode` values to Codex-style active `PermissionProfile` results.

**Architecture:** `packages/core/src/permission-profile-compiler.ts` will be a small pure adapter over the Phase 1 profile factory functions. It will preserve the original `PermissionMode` for existing `PermissionEngine` approval behavior while returning `profileName`, `profile`, `workspaceRoots`, and `network` for diagnostics and future sandbox backends.

**Tech Stack:** TypeScript ESM, Node built-in test runner, `@maka/core` package exports.

---

### File Structure

- Create: `packages/core/src/permission-profile-compiler.ts`
  - Owns `CompilePermissionProfileInput`, `CompiledPermissionProfile`, and `compilePermissionProfile()`.
- Create: `packages/core/src/__tests__/permission-profile-compiler.test.ts`
  - Verifies fixed mode-to-profile mapping, workspace root defaulting, optional workspace roots, and mode preservation.
- Modify: `packages/core/src/index.ts`
  - Re-exports compiler types and function from the barrel.
- Modify: `packages/core/package.json`
  - Adds `./permission-profile-compiler` subpath export.
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`
  - Marks Phase 2 items as complete after tests pass.

### Task 1: Write Compiler Tests First

**Files:**
- Create: `packages/core/src/__tests__/permission-profile-compiler.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compilePermissionProfile } from '../permission-profile-compiler.js';

describe('compilePermissionProfile', () => {
  it('maps explore to a read-only profile and defaults workspaceRoots to cwd', () => {
    const compiled = compilePermissionProfile({ mode: 'explore', cwd: '/repo' });

    assert.equal(compiled.mode, 'explore');
    assert.equal(compiled.profileName, 'read-only');
    assert.equal(compiled.profile.type, 'managed');
    assert.equal(compiled.profile.name, 'read-only');
    assert.equal(compiled.profile.fileSystem.kind, 'restricted');
    assert.deepEqual(compiled.workspaceRoots, ['/repo']);
    assert.deepEqual(compiled.network, { kind: 'restricted' });
  });

  it('maps ask and execute to the same workspace-write profile while preserving mode', () => {
    const ask = compilePermissionProfile({ mode: 'ask', cwd: '/repo' });
    const execute = compilePermissionProfile({ mode: 'execute', cwd: '/repo' });

    assert.equal(ask.mode, 'ask');
    assert.equal(execute.mode, 'execute');
    assert.equal(ask.profileName, 'workspace-write');
    assert.equal(execute.profileName, 'workspace-write');
    assert.equal(ask.profile.type, 'managed');
    assert.equal(execute.profile.type, 'managed');
    assert.equal(ask.profile.name, 'workspace-write');
    assert.equal(execute.profile.name, 'workspace-write');
    assert.deepEqual(ask.network, { kind: 'restricted' });
    assert.deepEqual(execute.network, { kind: 'restricted' });
  });

  it('maps bypass to danger-full-access', () => {
    const compiled = compilePermissionProfile({ mode: 'bypass', cwd: '/repo' });

    assert.equal(compiled.mode, 'bypass');
    assert.equal(compiled.profileName, 'danger-full-access');
    assert.equal(compiled.profile.type, 'managed');
    assert.equal(compiled.profile.name, 'danger-full-access');
    assert.equal(compiled.profile.fileSystem.kind, 'unrestricted');
    assert.deepEqual(compiled.network, { kind: 'enabled' });
  });

  it('uses explicit workspaceRoots when provided', () => {
    const compiled = compilePermissionProfile({
      mode: 'execute',
      cwd: '/repo',
      workspaceRoots: ['/repo', '/other-repo'],
    });

    assert.deepEqual(compiled.workspaceRoots, ['/repo', '/other-repo']);
  });
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `npm --workspace @maka/core test`

Expected: FAIL because `packages/core/src/permission-profile-compiler.ts` does not exist yet.

### Task 2: Implement Compiler

**Files:**
- Create: `packages/core/src/permission-profile-compiler.ts`

- [ ] **Step 1: Add minimal implementation**

```ts
import type { PermissionMode } from './permission.js';
import type {
  NetworkSandboxPolicy,
  PermissionProfile,
  PermissionProfileName,
} from './permission-profile.js';
import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from './permission-profile.js';

export interface CompilePermissionProfileInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
}

export interface CompiledPermissionProfile {
  mode: PermissionMode;
  profileName: PermissionProfileName;
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  network: NetworkSandboxPolicy;
}

export function compilePermissionProfile(input: CompilePermissionProfileInput): CompiledPermissionProfile {
  const workspaceRoots = input.workspaceRoots ?? [input.cwd];

  switch (input.mode) {
    case 'explore':
      return compileManaged(input.mode, createReadOnlyPermissionProfile(), workspaceRoots);
    case 'ask':
    case 'execute':
      return compileManaged(input.mode, createWorkspaceWritePermissionProfile(), workspaceRoots);
    case 'bypass':
      return compileManaged(input.mode, createDangerFullAccessPermissionProfile(), workspaceRoots);
  }
}

function compileManaged(
  mode: PermissionMode,
  profile: Extract<PermissionProfile, { type: 'managed' }>,
  workspaceRoots: readonly string[],
): CompiledPermissionProfile {
  return {
    mode,
    profileName: profile.name === 'read-only'
      || profile.name === 'workspace-write'
      || profile.name === 'danger-full-access'
      || profile.name === 'custom'
      ? profile.name
      : 'custom',
    profile,
    workspaceRoots,
    network: profile.network,
  };
}
```

- [ ] **Step 2: Run tests to verify green**

Run: `npm --workspace @maka/core test`

Expected: PASS.

### Task 3: Export Compiler API

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add barrel exports**

Add to `packages/core/src/index.ts` near the existing permission profile exports:

```ts
// permission-profile-compiler.ts
export type {
  CompilePermissionProfileInput,
  CompiledPermissionProfile,
} from './permission-profile-compiler.js';
export {
  compilePermissionProfile,
} from './permission-profile-compiler.js';
```

- [ ] **Step 2: Add package subpath export**

Add to `packages/core/package.json` exports:

```json
"./permission-profile-compiler": "./dist/permission-profile-compiler.js"
```

- [ ] **Step 3: Run tests**

Run: `npm --workspace @maka/core test`

Expected: PASS.

### Task 4: Update Todo Document

**Files:**
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`

- [ ] **Step 1: Mark Phase 2 checklist items complete**

Change each Phase 2 task checkbox from `[ ]` to `[x]` after implementation and tests pass.

- [ ] **Step 2: Run final verification**

Run: `npm --workspace @maka/core test`

Expected: PASS.

- [ ] **Step 3: Review git diff**

Run: `git diff -- packages/core/src/permission-profile-compiler.ts packages/core/src/__tests__/permission-profile-compiler.test.ts packages/core/src/index.ts packages/core/package.json docs/sandbox/agent-runtime-codex-sandbox-todo.md docs/superpowers/plans/2026-07-07-permission-profile-compiler.md`

Expected: Diff only contains Phase 2 compiler implementation, tests, exports, and planned todo updates.

### Self-Review

- Spec coverage: The plan covers compiler input, default `workspaceRoots`, fixed mode-to-profile mapping, ask/execute shared profile, preserved mode, diagnostics fields, exports, tests, and todo documentation.
- Placeholder scan: No placeholder implementation steps are left.
- Type consistency: The implementation uses Phase 1 `PermissionProfile`, `PermissionProfileName`, `NetworkSandboxPolicy`, and existing `PermissionMode` exactly as defined.
