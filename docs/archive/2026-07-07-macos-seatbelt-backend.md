# macOS Seatbelt Backend Implementation Plan

> Archived: the implementation landed in PR #631. This plan is retained only as historical execution context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS Seatbelt backend that converts Maka `PermissionProfile` plus explicit path context into SBPL policy text and `/usr/bin/sandbox-exec` argv.

**Architecture:** `packages/runtime/src/sandbox/macos-seatbelt.ts` owns the macOS-specific policy builder, exec-args builder, and `MacosSeatbeltBackend`. It consumes Phase 3 `SandboxCommand.pathContext`; it does not execute commands, does not wire into Bash, and does not implement Linux, managed network, or unsandboxed retry.

**Tech Stack:** TypeScript ESM, Node built-in test runner, macOS `/usr/bin/sandbox-exec`, `@maka/core` `PermissionProfile`, `@maka/runtime` sandbox types.

---

### File Structure

- Modify: `packages/runtime/src/sandbox/types.ts`
  - Ensures Phase 3 includes `SandboxPathContext` and `invalid_request` failure reason.
- Create: `packages/runtime/src/sandbox/macos-seatbelt.ts`
  - Owns `MACOS_SEATBELT_EXECUTABLE`, `MACOS_SEATBELT_BASE_POLICY`, `buildSeatbeltPolicy()`, `createSeatbeltExecArgs()`, `MacosSeatbeltBackend`, and small escaping/root resolution helpers.
- Create: `packages/runtime/src/sandbox/default-sandbox-manager.ts`
  - Owns `createDefaultSandboxManager()`, registering `MacosSeatbeltBackend` through constructor injection.
- Modify: `packages/runtime/src/sandbox/index.ts`
  - Re-exports macOS backend, policy helpers, and default manager factory.
- Create: `packages/runtime/src/__tests__/macos-seatbelt.test.ts`
  - Contract tests for policy text, `-D` parameterization, protected metadata requirements, network policy, and backend defensive failures.
- Create: `packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts`
  - macOS-only smoke tests using `/usr/bin/sandbox-exec`; non-macOS and missing binary skip.
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`
  - Adds Phase 4 implementation/non-implementation scope and marks Phase 4 items complete after tests pass.

### Task 1: Confirm Phase 3 Path Context Boundary

**Files:**
- Modify: `packages/runtime/src/sandbox/types.ts`
- Modify: `packages/runtime/src/__tests__/sandbox-manager.test.ts`

- [ ] **Step 1: Update sandbox type definitions**

In `packages/runtime/src/sandbox/types.ts`, ensure `SandboxTransformFailureReason` and `SandboxCommand` include the following:

```ts
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
```

- [ ] **Step 2: Update sandbox-manager tests to pass pathContext**

In `packages/runtime/src/__tests__/sandbox-manager.test.ts`, update the command helper to:

```ts
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
```

- [ ] **Step 3: Run runtime tests**

Run: `npm --workspace @maka/runtime test`

Expected: PASS after Phase 3 implementation is present.

### Task 2: Write macOS Seatbelt Contract Tests First

**Files:**
- Create: `packages/runtime/src/__tests__/macos-seatbelt.test.ts`

- [ ] **Step 1: Add failing contract tests**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  MACOS_SEATBELT_EXECUTABLE,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
} from '../sandbox/macos-seatbelt.js';
import type { SandboxTransformRequest } from '../sandbox/types.js';

function workspaceCommand(profile: PermissionProfile): SandboxTransformRequest {
  return {
    platform: 'darwin',
    command: {
      program: '/bin/zsh',
      args: ['-lc', 'echo ok'],
      cwd: '/repo',
      profile,
      pathContext: {
        workspaceRoots: ['/repo'],
        tmpdir: '/private/tmp/maka-test',
        slashTmp: '/tmp',
      },
    },
  };
}

function policyText(profile: PermissionProfile): string {
  return buildSeatbeltPolicy({
    profile,
    pathContext: {
      workspaceRoots: ['/repo'],
      tmpdir: '/private/tmp/maka-test',
      slashTmp: '/tmp',
    },
  }).policy;
}

function restrictedProfileWithEnabledNetwork(): PermissionProfile {
  return {
    type: 'managed',
    name: 'custom',
    fileSystem: {
      kind: 'restricted',
      entries: [
        { kind: 'special', access: 'write', special: ':workspace_roots' },
      ],
    },
    network: { kind: 'enabled' },
  };
}

describe('escapeSeatbeltRegex', () => {
  it('escapes regex metacharacters before inserting paths into SBPL regex literals', () => {
    assert.equal(
      escapeSeatbeltRegex('/tmp/repo.(test)+[x]'),
      '/tmp/repo\\.\\(test\\)\\+\\[x\\]',
    );
  });
});

describe('buildSeatbeltPolicy', () => {
  it('builds read-only policy with readable workspace roots and no writable workspace roots', () => {
    const result = buildSeatbeltPolicy({
      profile: createReadOnlyPermissionProfile(),
      pathContext: { workspaceRoots: ['/repo'] },
    });

    assert.match(result.policy, /\(version 1\)/);
    assert.match(result.policy, /\(deny default\)/);
    assert.match(result.policy, /\(allow file-read\*/);
    assert.match(result.policy, /\(subpath \(param "READABLE_ROOT_0"\)\)/);
    assert.doesNotMatch(result.policy, /WRITABLE_ROOT_0/);
    assert.deepEqual(result.definitionArgs, ['-DREADABLE_ROOT_0=/repo']);
  });

  it('builds workspace-write policy with parameterized workspace and temp roots', () => {
    const result = buildSeatbeltPolicy({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: {
        workspaceRoots: ['/repo'],
        tmpdir: '/private/tmp/maka-test',
        slashTmp: '/tmp',
      },
    });

    assert.match(result.policy, /\(subpath \(param "READABLE_ROOT_0"\)\)/);
    assert.match(result.policy, /\(subpath \(param "WRITABLE_ROOT_0"\)\)/);
    assert.deepEqual(result.definitionArgs, [
      '-DREADABLE_ROOT_0=/repo',
      '-DREADABLE_ROOT_1=/private/tmp/maka-test',
      '-DREADABLE_ROOT_2=/tmp',
      '-DWRITABLE_ROOT_0=/repo',
      '-DWRITABLE_ROOT_1=/private/tmp/maka-test',
      '-DWRITABLE_ROOT_2=/tmp',
    ]);
  });

  it('protects metadata names with require-not regex under writable workspace roots', () => {
    const policy = policyText(createWorkspaceWritePermissionProfile());

    assert.match(policy, /\(require-all \(subpath \(param "WRITABLE_ROOT_0"\)\)/);
    assert.ok(policy.includes(String.raw`(require-not (regex #"^/repo/(.*/)?\.git(/.*)?$"))`));
    assert.ok(policy.includes(String.raw`(require-not (regex #"^/repo/(.*/)?\.agents(/.*)?$"))`));
    assert.ok(policy.includes(String.raw`(require-not (regex #"^/repo/(.*/)?\.codex(/.*)?$"))`));
  });

  it('escapes workspace root before building protected metadata regex requirements', () => {
    const result = buildSeatbeltPolicy({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: ['/tmp/repo.(test)+[x]'] },
    });

    assert.match(result.policy, /\^\/tmp\/repo\\\.\\\(test\\\)\\\+\\\[x\\\]\/\(\.\*\/\)\?\\\.git/);
  });

  it('emits network restricted and enabled policy sections', () => {
    assert.match(policyText(createWorkspaceWritePermissionProfile()), /\(deny network\*\)/);
    assert.match(policyText(restrictedProfileWithEnabledNetwork()), /\(allow network\*\)/);
  });
});

describe('createSeatbeltExecArgs', () => {
  it('creates sandbox-exec arguments using -p policy, -D roots, -- separator, and inner argv', () => {
    const args = createSeatbeltExecArgs({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: ['/repo'] },
      innerArgv: ['/bin/zsh', '-lc', 'echo ok'],
    });

    assert.equal(args[0], '-p');
    assert.equal(args[2], '-DREADABLE_ROOT_0=/repo');
    assert.ok(args.includes('-DWRITABLE_ROOT_0=/repo'));
    const separator = args.indexOf('--');
    assert.notEqual(separator, -1);
    assert.deepEqual(args.slice(separator + 1), ['/bin/zsh', '-lc', 'echo ok']);
  });
});

describe('MacosSeatbeltBackend', () => {
  it('wraps inner argv with /usr/bin/sandbox-exec', () => {
    const backend = new MacosSeatbeltBackend();
    const result = backend.transform(workspaceCommand(createWorkspaceWritePermissionProfile()));

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.exec.argv[0], MACOS_SEATBELT_EXECUTABLE);
      assert.equal(result.exec.argv[1], '-p');
      assert.equal(result.exec.sandboxType, 'macos-seatbelt');
      assert.deepEqual(result.exec.argv.slice(-3), ['/bin/zsh', '-lc', 'echo ok']);
    }
  });

  it('returns invalid_request for profiles that should have selected none before reaching backend', () => {
    const backend = new MacosSeatbeltBackend();
    const result = backend.transform(workspaceCommand(createDangerFullAccessPermissionProfile()));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid_request');
      assert.match(result.message, /managed restricted/i);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `npm --workspace @maka/runtime test`

Expected: FAIL because `packages/runtime/src/sandbox/macos-seatbelt.ts` does not exist yet.

### Task 3: Implement macOS Seatbelt Policy Builder and Backend

**Files:**
- Create: `packages/runtime/src/sandbox/macos-seatbelt.ts`

- [ ] **Step 1: Add complete Phase 4 implementation**

```ts
import {
  PROTECTED_METADATA_NAMES,
  type FileSystemSandboxEntry,
  type PermissionProfile,
} from '@maka/core/permission-profile';
import type {
  SandboxBackend,
  SandboxPathContext,
  SandboxTransformRequest,
  SandboxTransformResult,
} from './types.js';

export const MACOS_SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';

export const MACOS_SEATBELT_BASE_POLICY = String.raw`
(version 1)
(deny default)

; Process and signal operations needed to run ordinary child processes.
(allow process*)
(allow signal (target self))

; Read-only macOS runtime surfaces required by shells and system binaries.
(allow sysctl-read)
(allow file-read-metadata (regex #"^/"))
(allow file-read*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (subpath "/System")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/bin")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/private/etc")
)
`.trim();

export interface BuildSeatbeltPolicyInput {
  profile: PermissionProfile;
  pathContext: SandboxPathContext;
}

export interface SeatbeltPolicyBuildResult {
  policy: string;
  definitionArgs: readonly string[];
}

export interface CreateSeatbeltExecArgsInput extends BuildSeatbeltPolicyInput {
  innerArgv: readonly string[];
}

interface SeatbeltRootPolicy {
  policy: string;
  definitionArgs: readonly string[];
}

export class MacosSeatbeltBackend implements SandboxBackend {
  readonly type = 'macos-seatbelt' as const;

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const innerArgv = [request.command.program, ...request.command.args];
    const validation = validateMacosSeatbeltProfile(request.command.profile);
    if (validation) {
      return {
        ok: false,
        reason: 'invalid_request',
        message: validation,
        sandboxType: 'macos-seatbelt',
        requiresSandbox: true,
        platform: request.platform ?? process.platform,
        preference: request.preference ?? 'auto',
        effectiveProfile: request.command.profile,
      };
    }

    const args = createSeatbeltExecArgs({
      profile: request.command.profile,
      pathContext: request.command.pathContext,
      innerArgv,
    });

    return {
      ok: true,
      exec: {
        argv: [MACOS_SEATBELT_EXECUTABLE, ...args],
        cwd: request.command.cwd,
        env: request.command.env,
        sandboxType: 'macos-seatbelt',
        effectiveProfile: request.command.profile,
      },
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      preference: request.preference ?? 'auto',
    };
  }
}

export function buildSeatbeltPolicy(input: BuildSeatbeltPolicyInput): SeatbeltPolicyBuildResult {
  const validation = validateMacosSeatbeltProfile(input.profile);
  if (validation) throw new Error(validation);
  if (input.profile.type !== 'managed') throw new Error('unreachable: validated profile must be managed');

  const readableRoots = resolveRoots(input.profile.fileSystem.entries, input.pathContext, ['read', 'write']);
  const writableRoots = resolveRoots(input.profile.fileSystem.entries, input.pathContext, ['write']);
  const readPolicy = buildRootPolicy('file-read*', 'READABLE_ROOT', readableRoots, []);
  const writePolicy = buildRootPolicy(
    'file-write*',
    'WRITABLE_ROOT',
    writableRoots,
    input.profile.fileSystem.protectedMetadata?.names ?? [],
  );

  const policy = [
    MACOS_SEATBELT_BASE_POLICY,
    readPolicy.policy,
    writePolicy.policy,
    buildNetworkPolicy(input.profile.network.kind),
  ]
    .filter((section) => section.trim().length > 0)
    .join('\n\n');

  return {
    policy,
    definitionArgs: [...readPolicy.definitionArgs, ...writePolicy.definitionArgs],
  };
}

export function createSeatbeltExecArgs(input: CreateSeatbeltExecArgsInput): readonly string[] {
  const built = buildSeatbeltPolicy(input);
  return ['-p', built.policy, ...built.definitionArgs, '--', ...input.innerArgv];
}

export function escapeSeatbeltRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function validateMacosSeatbeltProfile(profile: PermissionProfile): string | undefined {
  if (profile.type !== 'managed') {
    return 'MacosSeatbeltBackend requires a managed restricted PermissionProfile.';
  }
  if (profile.fileSystem.kind !== 'restricted') {
    return 'MacosSeatbeltBackend requires a managed restricted PermissionProfile.';
  }
  return undefined;
}

function buildNetworkPolicy(kind: 'restricted' | 'enabled'): string {
  return kind === 'enabled' ? '(allow network*)' : '(deny network*)';
}

function buildRootPolicy(
  action: 'file-read*' | 'file-write*',
  prefix: 'READABLE_ROOT' | 'WRITABLE_ROOT',
  roots: readonly string[],
  protectedMetadataNames: readonly string[],
): SeatbeltRootPolicy {
  const uniqueRoots = uniqueNormalizedRoots(roots);
  if (uniqueRoots.length === 0) {
    return { policy: '', definitionArgs: [] };
  }

  const definitionArgs: string[] = [];
  const components = uniqueRoots.map((root, index) => {
    const key = `${prefix}_${index}`;
    definitionArgs.push(`-D${key}=${root}`);
    if (protectedMetadataNames.length === 0) {
      return `(subpath (param "${key}"))`;
    }
    const requirements = [
      `(subpath (param "${key}"))`,
      ...protectedMetadataNames.map((name) => `(require-not (regex #"${protectedMetadataRegex(root, name)}"))`),
    ];
    return `(require-all ${requirements.join(' ')} )`;
  });

  return {
    policy: `(allow ${action}\n${components.join('\n')}\n)`,
    definitionArgs,
  };
}

function resolveRoots(
  entries: readonly FileSystemSandboxEntry[],
  context: SandboxPathContext,
  allowedAccess: readonly ('read' | 'write')[],
): readonly string[] {
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.access === 'deny') continue;
    if (!allowedAccess.includes(entry.access)) continue;
    roots.push(...rootsForEntry(entry, context));
  }
  return roots;
}

function rootsForEntry(entry: FileSystemSandboxEntry, context: SandboxPathContext): readonly string[] {
  if (entry.kind === 'path') return [entry.path];
  switch (entry.special) {
    case ':workspace_roots':
      return context.workspaceRoots;
    case ':tmpdir':
      return context.tmpdir ? [context.tmpdir] : [];
    case ':slash_tmp':
      return [context.slashTmp ?? '/tmp'];
    case ':minimal':
      return context.minimalRoots ?? [];
    case ':root':
      return ['/'];
  }
}

function uniqueNormalizedRoots(roots: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const normalized = normalizeRoot(root);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeRoot(root: string): string {
  if (root === '/') return '/';
  return root.replace(/\/+$/g, '');
}

function protectedMetadataRegex(root: string, name: string): string {
  const escapedRoot = escapeSeatbeltRegex(normalizeRoot(root));
  const escapedName = escapeSeatbeltRegex(name);
  if (escapedRoot === '/') return `^/${escapedName}(/.*)?$`;
  return `^${escapedRoot}/(.*/)?${escapedName}(/.*)?$`;
}

export const DEFAULT_PROTECTED_METADATA_NAMES = PROTECTED_METADATA_NAMES;
```

- [ ] **Step 2: Run tests to verify green for contract tests**

Run: `npm --workspace @maka/runtime test`

Expected: PASS for `macos-seatbelt.test.js` after Phase 3 implementation is present.

### Task 4: Export macOS Backend and Default Sandbox Manager

**Files:**
- Create: `packages/runtime/src/sandbox/default-sandbox-manager.ts`
- Modify: `packages/runtime/src/sandbox/index.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/src/__tests__/macos-seatbelt.test.ts`

- [ ] **Step 1: Add default manager factory**

```ts
import { SandboxManager } from './sandbox-manager.js';
import { MacosSeatbeltBackend } from './macos-seatbelt.js';

export function createDefaultSandboxManager(): SandboxManager {
  return new SandboxManager([
    new MacosSeatbeltBackend(),
  ]);
}
```

- [ ] **Step 2: Export macOS backend and default manager from sandbox index**

Add to `packages/runtime/src/sandbox/index.ts`:

```ts
export { createDefaultSandboxManager } from './default-sandbox-manager.js';
export {
  DEFAULT_PROTECTED_METADATA_NAMES,
  MACOS_SEATBELT_BASE_POLICY,
  MACOS_SEATBELT_EXECUTABLE,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
} from './macos-seatbelt.js';
export type {
  BuildSeatbeltPolicyInput,
  CreateSeatbeltExecArgsInput,
  SeatbeltPolicyBuildResult,
} from './macos-seatbelt.js';
```

- [ ] **Step 3: Export default manager from runtime barrel**

Add to `packages/runtime/src/index.ts` near existing sandbox exports:

```ts
export {
  createDefaultSandboxManager,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
} from './sandbox/index.js';
export type {
  BuildSeatbeltPolicyInput,
  CreateSeatbeltExecArgsInput,
  SeatbeltPolicyBuildResult,
} from './sandbox/index.js';
```

- [ ] **Step 4: Add default manager registration test**

Add this import to `packages/runtime/src/__tests__/macos-seatbelt.test.ts`:

```ts
import { createDefaultSandboxManager } from '../sandbox/default-sandbox-manager.js';
```

Add this test block:

```ts
describe('createDefaultSandboxManager', () => {
  it('registers the macOS Seatbelt backend for darwin selection', () => {
    const manager = createDefaultSandboxManager();

    const result = manager.selectInitial({
      profile: createWorkspaceWritePermissionProfile(),
      platform: 'darwin',
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sandboxType, 'macos-seatbelt');
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm --workspace @maka/runtime test`

Expected: PASS.

### Task 5: Add macOS-only Smoke Tests

**Files:**
- Create: `packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts`

- [ ] **Step 1: Add smoke tests with platform/binary skip**

```ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  MACOS_SEATBELT_EXECUTABLE,
  createSeatbeltExecArgs,
} from '../sandbox/macos-seatbelt.js';

const canSmoke = process.platform === 'darwin' && existsSync(MACOS_SEATBELT_EXECUTABLE);

describe('macOS Seatbelt smoke', { skip: canSmoke ? false : 'requires macOS /usr/bin/sandbox-exec' }, () => {
  it('allows writing ordinary files inside workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-seatbelt-workspace-'));
    const target = join(workspace, 'allowed.txt');
    const args = createSeatbeltExecArgs({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [workspace], slashTmp: '/tmp' },
      innerArgv: ['/bin/sh', '-c', 'printf allowed > "$1"', 'sh', target],
    });

    const result = spawnSync(MACOS_SEATBELT_EXECUTABLE, args, { cwd: workspace, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(target, 'utf8'), 'allowed');
  });

  it('blocks writing outside workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-seatbelt-workspace-'));
    const outsideRoot = await mkdtemp('/private/var/tmp/maka-seatbelt-outside-');
    const outside = join(outsideRoot, 'blocked.txt');
    const args = createSeatbeltExecArgs({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [workspace], slashTmp: '/tmp' },
      innerArgv: ['/bin/sh', '-c', 'printf blocked > "$1"', 'sh', outside],
    });

    const result = spawnSync(MACOS_SEATBELT_EXECUTABLE, args, { cwd: workspace, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
  });

  it('blocks writing protected metadata inside workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-seatbelt-workspace-'));
    const metadataFile = join(workspace, '.codex', 'config.toml');
    const args = createSeatbeltExecArgs({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [workspace], slashTmp: '/tmp' },
      innerArgv: ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && printf pwned > "$1"', 'sh', metadataFile],
    });

    const result = spawnSync(MACOS_SEATBELT_EXECUTABLE, args, { cwd: workspace, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
  });

  it('blocks direct network access under restricted network policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-seatbelt-workspace-'));
    const script = join(workspace, 'network.js');
    await writeFile(script, 'require("node:net").connect(80, "93.184.216.34").on("connect", () => process.exit(0)).on("error", () => process.exit(2));');
    const args = createSeatbeltExecArgs({
      profile: createWorkspaceWritePermissionProfile(),
      pathContext: { workspaceRoots: [workspace], slashTmp: '/tmp' },
      innerArgv: [process.execPath, script],
    });

    const result = spawnSync(MACOS_SEATBELT_EXECUTABLE, args, { cwd: workspace, encoding: 'utf8', timeout: 5_000 });

    assert.notEqual(result.status, 0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm --workspace @maka/runtime test`

Expected: PASS. On non-macOS, `macos-seatbelt-smoke.test.js` is skipped.

### Task 6: Update Todo, Verify, and Commit

**Files:**
- Modify: `docs/sandbox/agent-runtime-codex-sandbox-todo.md`

- [ ] **Step 1: Mark Phase 4 checklist items complete**

Change each Phase 4 task checkbox from `[ ]` to `[x]` after implementation and tests pass.

- [ ] **Step 2: Preserve explicit implementation scope in todo**

Keep the Phase 4 blockquote documentation stating:

```text
Phase 4 implements:
- macOS Seatbelt backend.
- PermissionProfile + pathContext -> SBPL policy.
- buildSeatbeltPolicy().
- createSeatbeltExecArgs().
- MacosSeatbeltBackend.transform().
- createDefaultSandboxManager().
- fixed /usr/bin/sandbox-exec path.
- readable/writable roots via -D parameterization.
- protected metadata deny-write via require-not regex.
- network restricted/enabled SBPL sections.
- contract tests and macOS-only smoke tests.

Phase 4 does not implement:
- Bash tool integration.
- argv runner.
- automatic runtime sandbox execution.
- Linux backend.
- Windows sandbox.
- managed network/proxy.
- unsandboxed retry.
- Read/Write/Edit/Glob/Grep profile enforcement.
```

- [ ] **Step 3: Run runtime test suite**

Run: `npm --workspace @maka/runtime test`

Expected: PASS.

- [ ] **Step 4: Review git diff**

Run: `git diff -- packages/runtime/src/sandbox/types.ts packages/runtime/src/sandbox/macos-seatbelt.ts packages/runtime/src/sandbox/default-sandbox-manager.ts packages/runtime/src/sandbox/index.ts packages/runtime/src/index.ts packages/runtime/src/__tests__/macos-seatbelt.test.ts packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts docs/sandbox/agent-runtime-codex-sandbox-todo.md docs/superpowers/plans/2026-07-07-macos-seatbelt-backend.md`

Expected: Diff only contains Phase 4 macOS Seatbelt backend, tests, exports, Phase 3 pathContext boundary adjustment, and planned todo updates.

- [ ] **Step 5: Commit Phase 4**

```bash
git add \
  packages/runtime/src/sandbox/types.ts \
  packages/runtime/src/sandbox/macos-seatbelt.ts \
  packages/runtime/src/sandbox/default-sandbox-manager.ts \
  packages/runtime/src/sandbox/index.ts \
  packages/runtime/src/index.ts \
  packages/runtime/src/__tests__/macos-seatbelt.test.ts \
  packages/runtime/src/__tests__/macos-seatbelt-smoke.test.ts \
  docs/sandbox/agent-runtime-codex-sandbox-todo.md \
  docs/superpowers/plans/2026-07-07-macos-seatbelt-backend.md
git commit -m "feat(runtime): add macos seatbelt sandbox backend"
```

### Self-Review

- Spec coverage: The plan covers Maka-owned macOS base policy, profile/pathContext to SBPL conversion, `-D` parameterization, protected metadata `require-not regex`, restricted/enabled network sections, fixed `/usr/bin/sandbox-exec`, `MacosSeatbeltBackend.transform()`, `createDefaultSandboxManager()`, contract tests, and macOS-only smoke tests.
- Non-goals preserved: The plan explicitly excludes Bash integration, argv runner execution, Linux/Windows backends, managed network/proxy, unsandboxed retry, and file-tool profile enforcement.
- Placeholder scan: No placeholder implementation steps are left.
- Type consistency: Phase 4 uses Phase 3 `SandboxPathContext`, `SandboxTransformRequest`, `SandboxTransformResult`, and `SandboxBackend` consistently.
