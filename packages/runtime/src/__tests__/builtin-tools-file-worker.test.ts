import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';

import { buildBuiltinTools } from '../builtin-tools.js';
import type { AdditionalPermissionGrant } from '../additional-permissions.js';
import type { FilesystemWorkerExecuteInput } from '../filesystem-worker/client.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('builtin file tools use the sandboxed worker', () => {
  test('requires a macOS filesystem worker before enabling one-call file permissions', () => {
    assert.throws(
      () => buildBuiltinTools({ enableFileToolAdditionalPermissions: true }),
      /require a sandboxed filesystem worker/,
    );
    assert.throws(
      () =>
        buildBuiltinTools({
          filesystemWorker: { execute: async () => ({ kind: 'read', content: '' }) },
          enableFileToolAdditionalPermissions: true,
          sandboxPlatform: 'linux',
        }),
      /supported only on macOS/,
    );
  });

  test('plans the minimum one-call permission for an outside Write', async () => {
    const cwd = await temporaryDirectory('maka-file-plan-cwd-');
    const path = join(parse(cwd).root, `maka-file-plan-outside-${process.pid}`, 'created.txt');
    const write = buildBuiltinTools({
      filesystemWorker: { execute: async () => ({ kind: 'read', content: '' }) },
      enableFileToolAdditionalPermissions: true,
      sandboxPlatform: 'darwin',
    }).find((tool) => tool.name === 'Write');
    assert.ok(write?.planAdditionalPermissions);

    const args = { path, content: 'created' };
    const plan = await write.planAdditionalPermissions(args, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      category: 'file_write',
      cwd,
      mode: 'ask',
      args,
    });
    assert.equal(plan.kind, 'request');
    if (plan.kind === 'request') {
      assert.deepEqual(plan.proposal.profile.fileSystem?.entries, [
        {
          path,
          access: 'write',
          scope: 'exact',
        },
      ]);
      assert.equal(plan.proposal.risk.outsideWorkspace, true);
    }
  });

  test('forwards the consumed grant only to the current worker operation', async () => {
    const cwd = await temporaryDirectory('maka-file-worker-cwd-');
    const calls: FilesystemWorkerExecuteInput[] = [];
    const grant = fakeGrant();
    const permissionProfile = createReadOnlyPermissionProfile();
    const tools = buildBuiltinTools({
      filesystemWorker: {
        execute: async (input) => {
          calls.push(input);
          switch (input.operation.kind) {
            case 'read':
              return { kind: 'read', content: 'worker-content' };
            case 'write':
              return { kind: 'write', ok: true, path: input.operation.path, bytes: 7 };
            case 'edit':
              return {
                kind: 'edit',
                ok: true,
                path: input.operation.path,
                replacements: 1,
                matchedVia: 'exact',
                startLine: 1,
                endLine: 1,
              };
            case 'format_json':
              return {
                kind: 'format_json',
                ok: true,
                valid: true,
                path: input.operation.path,
                bytesBefore: 2,
                bytesAfter: 3,
                byteDelta: 1,
                changed: true,
              };
            case 'glob':
              return { kind: 'glob', files: ['worker.ts'] };
            case 'grep':
              return { kind: 'grep', matches: ['worker.ts:1:value'] };
          }
        },
      },
      permissionProfile,
      sandboxPlatform: 'darwin',
    });

    await runTool(tools, 'Read', { path: 'read.txt' }, cwd, grant);
    await runTool(tools, 'Write', { path: 'write.txt', content: 'content' }, cwd, grant);
    await runTool(
      tools,
      'Edit',
      { path: 'edit.txt', old_string: 'a', new_string: 'b' },
      cwd,
      grant,
    );
    await runTool(tools, 'FormatJson', { path: 'data.json' }, cwd, grant);
    await runTool(tools, 'Glob', { pattern: '**/*.ts' }, cwd, grant);
    await runTool(tools, 'Grep', { pattern: 'value' }, cwd, grant);

    assert.deepEqual(
      calls.map((call) => call.operation.kind),
      ['read', 'write', 'edit', 'format_json', 'glob', 'grep'],
    );
    assert.equal(
      calls.every((call) => call.additionalGrant === grant),
      true,
    );
    assert.equal(
      calls.every((call) => call.mode === 'ask' && call.cwd === cwd),
      true,
    );
    assert.equal(
      calls.every((call) => call.permissionProfile === permissionProfile),
      true,
    );
  });

  test('uses one worker read operation for image paths', async () => {
    const cwd = await temporaryDirectory('maka-file-worker-cwd-');
    const calls: FilesystemWorkerExecuteInput[] = [];
    const tools = buildBuiltinTools({
      filesystemWorker: {
        execute: async (input) => {
          calls.push(input);
          return { kind: 'read_image', base64: 'iVBORw0KGgo=', mimeType: 'image/png' };
        },
      },
      snapshotImage: async () => ({
        kind: 'session_file',
        sessionId: 'session-1',
        relativePath: 'artifact-1',
      }),
      sandboxPlatform: 'darwin',
    });

    await runTool(tools, 'Read', { path: 'image.png', offset: 1, limit: 1 }, cwd);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.operation, { kind: 'read', path: 'image.png', offset: 1, limit: 1 });
  });

  test('plans Grep with exact file and subtree directory permissions', async () => {
    const root = await temporaryDirectory('maka-file-grep-plan-');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await Promise.all([
      writeFile(join(workspace, 'inside.ts'), 'inside', 'utf8'),
      writeFile(join(outside, 'outside.ts'), 'outside', 'utf8'),
    ]);
    const grep = buildBuiltinTools({
      filesystemWorker: { execute: async () => ({ kind: 'grep', matches: [] }) },
      permissionProfile: createReadOnlyPermissionProfile(),
      enableFileToolAdditionalPermissions: true,
      sandboxPlatform: 'darwin',
    }).find((tool) => tool.name === 'Grep');
    assert.ok(grep?.planAdditionalPermissions);

    const insideArgs = { pattern: 'inside', path: 'inside.ts' };
    const insidePlan = await planFileTool(grep, insideArgs, workspace, 'explore');
    assert.equal(insidePlan.kind, 'not_required');

    const fileArgs = { pattern: 'outside', path: join(outside, 'outside.ts') };
    const filePlan = await planFileTool(grep, fileArgs, workspace, 'ask');
    assert.equal(filePlan.kind, 'request');
    if (filePlan.kind === 'request') {
      assert.deepEqual(filePlan.proposal.profile.fileSystem?.entries, [
        {
          path: join(outside, 'outside.ts'),
          access: 'read',
          scope: 'exact',
        },
      ]);
    }

    const directoryArgs = { pattern: 'outside', path: outside };
    const directoryPlan = await planFileTool(grep, directoryArgs, workspace, 'ask');
    assert.equal(directoryPlan.kind, 'request');
    if (directoryPlan.kind === 'request') {
      assert.deepEqual(directoryPlan.proposal.profile.fileSystem?.entries, [
        {
          path: outside,
          access: 'read',
          scope: 'subtree',
        },
      ]);
    }
  });

  test('uses canonical workspace roots when planning through a symlinked cwd', async () => {
    const root = await temporaryDirectory('maka-file-plan-alias-');
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await writeFile(join(workspace, 'inside.ts'), 'inside', 'utf8');
    await symlink(workspace, alias, 'dir');
    const tools = buildBuiltinTools({
      filesystemWorker: { execute: async () => ({ kind: 'read', content: '' }) },
      enableFileToolAdditionalPermissions: true,
      sandboxPlatform: 'darwin',
    });
    const read = tools.find((tool) => tool.name === 'Read');
    const grep = tools.find((tool) => tool.name === 'Grep');
    assert.ok(read?.planAdditionalPermissions);
    assert.ok(grep?.planAdditionalPermissions);

    assert.equal(
      (await planFileTool(read, { path: 'inside.ts' }, alias, 'explore')).kind,
      'not_required',
    );
    assert.equal(
      (await planFileTool(grep, { pattern: 'inside', path: 'inside.ts' }, alias, 'explore')).kind,
      'not_required',
    );
  });

  test('serializes writes through real and symlinked cwd paths', async () => {
    const root = await temporaryDirectory('maka-file-lock-alias-');
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await writeFile(join(workspace, 'shared.txt'), 'before', 'utf8');
    await symlink(workspace, alias, 'dir');
    let active = 0;
    let maxActive = 0;
    const calls: FilesystemWorkerExecuteInput[] = [];
    const tools = buildBuiltinTools({
      filesystemWorker: {
        execute: async (input) => {
          calls.push(input);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return {
            kind: 'edit',
            ok: true,
            path: input.operation.path,
            replacements: 1,
            matchedVia: 'exact',
            startLine: 1,
            endLine: 1,
          };
        },
      },
      sandboxPlatform: 'darwin',
    });

    await Promise.all([
      runTool(
        tools,
        'Edit',
        { path: 'shared.txt', old_string: 'before', new_string: 'real' },
        workspace,
      ),
      runTool(
        tools,
        'Edit',
        { path: 'shared.txt', old_string: 'before', new_string: 'alias' },
        alias,
      ),
    ]);

    assert.equal(maxActive, 1);
    assert.deepEqual(
      calls.map((call) => call.cwd),
      [workspace, workspace],
    );
  });
});

async function planFileTool(
  tool: NonNullable<ReturnType<typeof buildBuiltinTools>[number]>,
  args: Record<string, unknown>,
  cwd: string,
  mode: 'explore' | 'ask',
) {
  if (!tool.planAdditionalPermissions) throw new Error(`${tool.name} planner missing`);
  return await tool.planAdditionalPermissions(args, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: `tool-${tool.name}`,
    toolName: tool.name,
    category: 'read',
    cwd,
    mode,
    args,
  });
}

async function runTool(
  tools: ReturnType<typeof buildBuiltinTools>,
  name: string,
  args: unknown,
  cwd: string,
  grant?: AdditionalPermissionGrant,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool missing`);
  return await tool.impl(args as never, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: `tool-${name}`,
    cwd,
    permissionMode: 'ask',
    ...(grant ? { permissionContext: { additionalGrant: grant } } : {}),
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  });
}

function fakeGrant(): AdditionalPermissionGrant {
  return {
    grantId: 'grant-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'tool-1',
    toolName: 'Write',
    intentHash: `sha256:${'1'.repeat(64)}`,
    permissionsHash: `sha256:${'2'.repeat(64)}`,
    profile: { fileSystem: { entries: [{ path: '/tmp/file', access: 'write', scope: 'exact' }] } },
    normalizedPaths: [],
    risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
    issuedAt: 1,
    expiresAt: 2,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return await realpath(path);
}
