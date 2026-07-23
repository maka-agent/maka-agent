import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  adoptWorkspaceIdentityOnImport,
  resolveWorkspaceIdentity,
  WORKSPACE_IDENTITY_PREFIX,
  WORKSPACE_MARKER_FILE,
  WorkspaceIdentityError,
} from '../workspace-identity.js';

const execFileAsync = promisify(execFile);

test('creating a workspace identity keeps a Git worktree clean', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-clean-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    await resolveWorkspaceIdentity({ path: workspace });

    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an existing workspace marker becomes locally ignored after Git initialization', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-existing-'));
  try {
    const original = await resolveWorkspaceIdentity({ path: workspace });
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const resolved = await resolveWorkspaceIdentity({ path: workspace });

    assert.equal(resolved.workspaceIdentity, original.workspaceIdentity);
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a subdirectory workspace stays clean inside a linked Git worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-git-linked-'));
  try {
    const repository = join(base, 'repository');
    const linkedWorktree = join(base, 'linked');
    const workspace = join(linkedWorktree, 'nested', 'workspace');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
    await writeFile(join(repository, 'tracked.txt'), 'tracked\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Maka Test',
        '-c',
        'user.email=test@maka.invalid',
        'commit',
        '--quiet',
        '-m',
        'init',
      ],
      { cwd: repository },
    );
    await execFileAsync(
      'git',
      ['worktree', 'add', '--quiet', '-b', 'linked-test', linkedWorktree],
      {
        cwd: repository,
      },
    );
    await mkdir(workspace, { recursive: true });

    await resolveWorkspaceIdentity({ path: workspace });

    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: linkedWorktree, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repeated Git workspace resolution adds one local exclude rule', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-idempotent-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    await resolveWorkspaceIdentity({ path: workspace });
    await resolveWorkspaceIdentity({ path: workspace });

    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { cwd: workspace, encoding: 'utf8' },
    );
    const rules = (await readFile(stdout.trim(), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line === WORKSPACE_MARKER_FILE);
    assert.equal(rules.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('concurrent Git workspace resolution returns one clean identity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-concurrent-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const resolutions = await Promise.all(
      Array.from({ length: 8 }, () => resolveWorkspaceIdentity({ path: workspace })),
    );

    assert.equal(new Set(resolutions.map((resolution) => resolution.workspaceIdentity)).size, 1);
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a malformed enclosing Git repository prevents publishing a new marker', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-malformed-'));
  try {
    await writeFile(join(workspace, '.git'), 'gitdir: /missing/maka-git-dir\n', 'utf8');

    await assert.rejects(
      () => resolveWorkspaceIdentity({ path: workspace }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'workspace_io_failed',
    );
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a non-Git workspace resolves when the Git executable is unavailable', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-no-git-required-'));
  try {
    await resolveWorkspaceIdentityWithoutGit(workspace);

    await access(join(workspace, WORKSPACE_MARKER_FILE));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a Git workspace does not publish a marker when the Git executable is unavailable', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-git-unavailable-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    await assert.rejects(resolveWorkspaceIdentityWithoutGit(workspace));
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an unmarked read-only workspace fails without leaving marker state', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-read-only-'));
  try {
    await chmod(workspace, 0o555);

    await assert.rejects(
      () => resolveWorkspaceIdentity({ path: workspace }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'workspace_io_failed',
    );
    await assert.rejects(access(join(workspace, WORKSPACE_MARKER_FILE)), { code: 'ENOENT' });
  } finally {
    await chmod(workspace, 0o755);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a tar archive round-trip preserves workspace identity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-identity-'));
  try {
    const source = join(base, 'source');
    const imported = join(base, 'imported');
    const archive = join(base, 'workspace.tar');
    await mkdir(source);
    const original = await resolveWorkspaceIdentity({ path: source });
    const markerBefore = await readFile(join(source, WORKSPACE_MARKER_FILE), 'utf8');

    await mkdir(imported);
    await execFileAsync('tar', ['-cf', archive, '-C', source, '.']);
    await execFileAsync('tar', ['-xf', archive, '-C', imported]);
    assert.equal(await readFile(join(imported, WORKSPACE_MARKER_FILE), 'utf8'), markerBefore);
    const adopted = await adoptWorkspaceIdentityOnImport({
      path: imported,
      expectedWorkspaceIdentity: original.workspaceIdentity,
    });

    assert.equal(adopted.workspaceIdentity, original.workspaceIdentity);
    assert.match(adopted.workspaceIdentity, new RegExp(`^${WORKSPACE_IDENTITY_PREFIX}`));
    assert.equal(await readFile(join(imported, WORKSPACE_MARKER_FILE), 'utf8'), markerBefore);
    assert.equal(
      JSON.parse(await readFile(join(imported, WORKSPACE_MARKER_FILE), 'utf8')).workspaceId,
      JSON.parse(markerBefore).workspaceId,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('importing an existing marker into a Git worktree keeps it clean', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-import-git-'));
  try {
    const source = join(base, 'source');
    const imported = join(base, 'imported');
    await mkdir(source);
    await mkdir(imported);
    const original = await resolveWorkspaceIdentity({ path: source });
    await writeFile(
      join(imported, WORKSPACE_MARKER_FILE),
      await readFile(join(source, WORKSPACE_MARKER_FILE)),
    );
    await execFileAsync('git', ['init', '--quiet'], { cwd: imported });

    const adopted = await adoptWorkspaceIdentityOnImport({
      path: imported,
      expectedWorkspaceIdentity: original.workspaceIdentity,
    });

    assert.equal(adopted.workspaceIdentity, original.workspaceIdentity);
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: imported, encoding: 'utf8' },
    );
    assert.equal(stdout, '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('explicit import adoption records a pre-marker legacy filesystem anchor', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-legacy-'));
  try {
    const legacyWorkspaceIdentity = 'fs:7:42:/old-sandbox/repo';
    const adopted = await adoptWorkspaceIdentityOnImport({
      path: workspace,
      legacyWorkspaceIdentity,
    });

    assert.ok(adopted.legacyWorkspaceIdentities.includes(legacyWorkspaceIdentity));
    assert.equal(
      (await resolveWorkspaceIdentity({ path: workspace })).workspaceIdentity,
      adopted.workspaceIdentity,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('import adoption rejects a conflicting workspace UUID', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-conflict-'));
  try {
    await resolveWorkspaceIdentity({ path: workspace });
    await assert.rejects(
      () =>
        adoptWorkspaceIdentityOnImport({
          path: workspace,
          expectedWorkspaceIdentity: 'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
        }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'workspace_identity_conflict',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('import adoption rejects an alias overflow without changing the durable marker', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-alias-overflow-'));
  try {
    const original = await resolveWorkspaceIdentity({ path: workspace });
    const markerPath = join(workspace, WORKSPACE_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      schemaVersion: number;
      workspaceId: string;
      legacyAnchors: string[];
    };
    marker.legacyAnchors = Array.from(
      { length: 32 },
      (_, index) => `fs:1:${index + 1}:/legacy/workspace-${index}`,
    );
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
    const markerBefore = await readFile(markerPath);

    await assert.rejects(
      () =>
        adoptWorkspaceIdentityOnImport({
          path: workspace,
          legacyWorkspaceIdentity: 'fs:9:9:/legacy/overflow',
        }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'invalid_workspace_marker',
    );

    assert.deepEqual(await readFile(markerPath), markerBefore);
    assert.equal(
      (await resolveWorkspaceIdentity({ path: workspace })).workspaceIdentity,
      original.workspaceIdentity,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('import adoption rejects a marker size overflow without changing the durable marker', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'maka-workspace-size-overflow-'));
  try {
    const original = await resolveWorkspaceIdentity({ path: workspace });
    const markerPath = join(workspace, WORKSPACE_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      schemaVersion: number;
      workspaceId: string;
      legacyAnchors: string[];
    };
    marker.legacyAnchors = [`fs:1:1:/${'a'.repeat(1_900)}`, `fs:1:2:/${'b'.repeat(1_900)}`];
    const markerBeforeText = `${JSON.stringify(marker)}\n`;
    const overflowAlias = `fs:1:3:/${'c'.repeat(300)}`;
    assert.ok(Buffer.byteLength(markerBeforeText, 'utf8') <= 4_096);
    assert.ok(
      Buffer.byteLength(
        `${JSON.stringify({ ...marker, legacyAnchors: [...marker.legacyAnchors, overflowAlias] })}\n`,
        'utf8',
      ) > 4_096,
    );
    await writeFile(markerPath, markerBeforeText, 'utf8');
    const markerBefore = await readFile(markerPath);

    await assert.rejects(
      () =>
        adoptWorkspaceIdentityOnImport({
          path: workspace,
          legacyWorkspaceIdentity: overflowAlias,
        }),
      (error: unknown) =>
        error instanceof WorkspaceIdentityError && error.code === 'invalid_workspace_marker',
    );

    assert.deepEqual(await readFile(markerPath), markerBefore);
    assert.equal(
      (await resolveWorkspaceIdentity({ path: workspace })).workspaceIdentity,
      original.workspaceIdentity,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function resolveWorkspaceIdentityWithoutGit(workspace: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' };
  delete env.Path;
  const moduleUrl = new URL('../workspace-identity.js', import.meta.url).href;
  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const [moduleUrl, workspace] = process.argv.slice(1); const { resolveWorkspaceIdentity } = await import(moduleUrl); await resolveWorkspaceIdentity({ path: workspace });',
      moduleUrl,
      workspace,
    ],
    { env },
  );
}
