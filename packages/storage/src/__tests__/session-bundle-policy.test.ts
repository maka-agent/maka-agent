import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import {
  assertSessionBundleRootLayout,
  exportSessionBundleState,
  planSessionBundleExport,
  type SessionBundleExportError,
} from '../session-bundle-policy.js';
import { createSessionStore } from '../session-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

test('exports one session only and excludes credential/config canaries', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    const selected = await sessions.create(sessionInput('Selected'));
    const other = await sessions.create(sessionInput('Other'));
    await sessions.appendMessage(selected.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 10,
      text: 'selected transcript',
    });
    await sessions.close?.();
    const selectedSessionRoot = join(stateRoot, 'sessions', selected.id);
    const portableSessionEntries = [
      ['runs/run-1/run.json', '{"run":"selected"}\n'],
      ['projections/history-compact.json', '{"projection":"selected"}\n'],
      ['turn-admissions/turn-1.json', '{"turn":"selected"}\n'],
      ['shell-runs/shell-1/shell-run.json', '{"shell":"selected"}\n'],
      ['deep-research/events.jsonl', '{"research":"selected"}\n'],
      ['tasks.json', '{"tasks":[]}\n'],
      ['task-events.jsonl', '{"task":"selected"}\n'],
      ['agent-mailbox.jsonl', '{"mail":"selected"}\n'],
      ['plan-events.jsonl', '{"planEvent":"selected"}\n'],
      ['plans.json', '{"plans":[]}\n'],
    ] as const;
    for (const [relativePath, contents] of portableSessionEntries) {
      const path = join(selectedSessionRoot, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    await mkdir(join(stateRoot, 'artifacts', selected.id), { recursive: true });
    await mkdir(join(stateRoot, 'artifacts', other.id), { recursive: true });
    await writeFile(join(stateRoot, 'artifacts', selected.id, 'output.txt'), 'session output\n');
    await writeFile(join(stateRoot, 'artifacts', other.id, 'other-output.txt'), 'other output\n');
    await writeFile(
      join(stateRoot, 'artifacts', 'metadata.jsonl'),
      [
        JSON.stringify({
          sessionId: selected.id,
          relativePath: `${selected.id}/output.txt`,
        }),
        JSON.stringify({
          sessionId: other.id,
          relativePath: `${other.id}/other-output.txt`,
        }),
      ].join('\n') + '\n',
    );
    const runtime = createSqliteRuntimeStore(join(stateRoot, 'runtime.sqlite'));
    await runtime.appendRuntimeEvent(
      selected.id,
      'run-1',
      runtimeEvent('event-1', { sessionId: selected.id }),
    );
    await runtime.appendRuntimeEvent(
      other.id,
      'run-2',
      runtimeEvent('event-2', {
        sessionId: other.id,
        runId: 'run-2',
        invocationId: 'run-2',
      }),
    );
    runtime.close();
    await writeFile(join(stateRoot, 'credentials.json'), 'super-secret-api-key');
    await writeFile(join(stateRoot, 'llm-connections.json'), 'host-provider-config');
    await writeFile(join(stateRoot, '.maka_cli_claude_device_id'), 'device-identity');
    await writeFile(join(configRoot, 'credentials.json'), 'config-secret-canary');

    const plan = await exportSessionBundleState({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId: selected.id,
    });

    assert.deepEqual(plan.includedEntries, ['artifacts', 'runtime.sqlite', 'sessions']);
    assert.deepEqual(
      [...plan.excludedEntries].sort(),
      [
        '.maka_cli_claude_device_id',
        'credentials.json',
        'llm-connections.json',
        'sessions.sqlite',
        `artifacts/${other.id}`,
        `sessions/${other.id}`,
      ].sort(),
    );
    const exportedTranscript = await readFile(
      join(destinationRoot, 'sessions', selected.id, 'session.jsonl'),
      'utf8',
    );
    const [exportedHeader, exportedMessage] = exportedTranscript
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(exportedHeader.id, selected.id);
    assert.equal(exportedHeader.name, 'Selected');
    assert.equal(exportedHeader.type, undefined);
    assert.equal(exportedMessage.text, 'selected transcript');
    for (const [relativePath, contents] of portableSessionEntries) {
      assert.equal(
        await readFile(join(destinationRoot, 'sessions', selected.id, relativePath), 'utf8'),
        contents,
      );
    }
    await assert.rejects(readFile(join(destinationRoot, 'sessions', other.id, 'session.jsonl')));
    await assert.rejects(readFile(join(destinationRoot, 'sessions.sqlite')));
    await assert.rejects(
      readFile(join(destinationRoot, 'artifacts', other.id, 'other-output.txt')),
    );
    assert.match(
      await readFile(join(destinationRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
      new RegExp(`"sessionId":"${selected.id}"`),
    );
    assert.doesNotMatch(
      await readFile(join(destinationRoot, 'artifacts', 'metadata.jsonl'), 'utf8'),
      new RegExp(other.id),
    );
    const exportedRuntime = createSqliteRuntimeStore(join(destinationRoot, 'runtime.sqlite'));
    try {
      assert.equal((await exportedRuntime.readSessionRuntimeEvents(selected.id)).length, 1);
      assert.equal((await exportedRuntime.readSessionRuntimeEvents(other.id)).length, 0);
    } finally {
      exportedRuntime.close();
    }
    await assert.rejects(readFile(join(destinationRoot, 'credentials.json'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, 'llm-connections.json'), 'utf8'));
    await assert.rejects(readFile(join(destinationRoot, '.maka_cli_claude_device_id'), 'utf8'));
    assert.equal(
      await readFile(join(configRoot, 'credentials.json'), 'utf8'),
      'config-secret-canary',
    );
  });
});

test('fails closed on unknown top-level state entries', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    await writeFile(join(stateRoot, 'new-secret-store.json'), 'unknown-secret');

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId: 'session-1' }),
      'unknown_entry',
    );
  });
});

test('fails closed on unknown entries inside the selected session', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    await writeFile(
      join(stateRoot, 'sessions', sessionId, 'unclassified-cache.json'),
      '{"secret":"must-not-export"}\n',
    );

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
      'unknown_entry',
    );
  });
});

test('fails closed on symlinked state entries and path escape', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot, root }) => {
    const outside = join(root, 'outside-secret.txt');
    await writeFile(outside, 'outside-secret');
    const sessionId = await createSelectedSession(stateRoot);
    await symlink(outside, join(stateRoot, 'sessions', sessionId, 'escaped.txt'));

    await assertExportError(
      planSessionBundleExport({ stateRoot, configRoot, destinationRoot, sessionId }),
      'symlink',
    );
  });
});

test('rejects unsafe root overlap while allowing explicit legacy sharing', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot }) => {
    await assertSessionBundleRootLayout({ stateRoot, configRoot });
    await assertSessionBundleRootLayout({
      stateRoot,
      configRoot: stateRoot,
      allowShared: true,
    });

    await assertExportError(
      assertSessionBundleRootLayout({
        stateRoot,
        configRoot: join(stateRoot, 'config'),
      }),
      'overlapping_roots',
    );
  });
});

test('rejects a bundle destination nested inside a source root', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot }) => {
    await assertExportError(
      planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot: join(stateRoot, 'bundle'),
        sessionId: 'session-1',
      }),
      'overlapping_roots',
    );
  });
});

test('preserves the complete suffix for a deeply missing destination path', async () => {
  await withBundleRoots(async ({ root, stateRoot, configRoot }) => {
    const sessionId = await createSelectedSession(stateRoot);
    const destinationRoot = join(root, 'missing', 'deep', 'bundle');
    const plan = await planSessionBundleExport({
      stateRoot,
      configRoot,
      destinationRoot,
      sessionId,
    });
    assert.equal(plan.destinationRoot, resolve(await realpath(root), 'missing', 'deep', 'bundle'));
  });
});

test('fails closed when the state root contains no sessions', async () => {
  await withBundleRoots(async ({ stateRoot, configRoot, destinationRoot }) => {
    const sessions = createSessionStore(stateRoot);
    await sessions.close?.();
    await assertExportError(
      planSessionBundleExport({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: 'missing-session',
      }),
      'invalid_root',
    );
  });
});

async function assertExportError(
  operation: Promise<unknown>,
  code: SessionBundleExportError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as SessionBundleExportError).code, code);
    return true;
  });
}

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: id },
    ...overrides,
  };
}

function sessionInput(name: string) {
  return {
    cwd: '/repo',
    backend: 'fake' as const,
    llmConnectionSlug: 'fixture',
    model: 'fixture-model',
    permissionMode: 'execute' as const,
    name,
  };
}

async function createSelectedSession(stateRoot: string): Promise<string> {
  const sessions = createSessionStore(stateRoot);
  try {
    return (await sessions.create(sessionInput('Selected'))).id;
  } finally {
    await sessions.close?.();
  }
}

async function withBundleRoots(
  fn: (roots: {
    root: string;
    stateRoot: string;
    configRoot: string;
    destinationRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-'));
  const stateRoot = join(root, 'state');
  const configRoot = join(root, 'config');
  const destinationRoot = join(root, 'export');
  await Promise.all([mkdir(stateRoot), mkdir(configRoot)]);
  try {
    await fn({ root, stateRoot, configRoot, destinationRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
