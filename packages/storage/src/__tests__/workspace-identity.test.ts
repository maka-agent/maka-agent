import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  adoptWorkspaceIdentityOnImport,
  resolveWorkspaceIdentity,
  WORKSPACE_IDENTITY_PREFIX,
  WORKSPACE_MARKER_FILE,
  WorkspaceIdentityError,
} from '../workspace-identity.js';

test('a copied marker preserves workspace identity across archive extraction', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-workspace-identity-'));
  try {
    const source = join(base, 'source');
    const imported = join(base, 'imported');
    await mkdir(source);
    const original = await resolveWorkspaceIdentity({ path: source });
    const markerBefore = await readFile(join(source, WORKSPACE_MARKER_FILE), 'utf8');

    await cp(source, imported, { recursive: true });
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
