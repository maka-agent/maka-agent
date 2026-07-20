import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeHostConnection } from '../client/index.js';
import type { TaskLedgerQueryResult } from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

test('two UDS Clients share one paginated Task Ledger projection across Host epochs', async () => {
  await withExecutionRoot(async (fixture) => {
    const created = await fixture.createTasks(
      Array.from({ length: 130 }, (_, index) => `task ${index + 1}`),
    );
    const firstHost = await fixture.startHost();
    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    let firstPage: Page | undefined;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');

      const [desktopPage, tuiPage] = await Promise.all([
        queryFirstPage(desktop, fixture.sessionId),
        queryFirstPage(tui, fixture.sessionId),
      ]);
      assert.deepEqual(tuiPage, desktopPage);
      assert.notEqual(desktopPage.nextCursor, null);
      firstPage = desktopPage;

      const [desktopTasks, tuiTasks] = await Promise.all([
        collectTasks(desktop, desktopPage),
        collectTasks(tui, tuiPage),
      ]);
      assert.deepEqual(tuiTasks, desktopTasks);
      assert.equal(desktopTasks.length, created.length);

      const byKey = await tui.request('task.ledger.query', {
        kind: 'get',
        sessionId: fixture.sessionId,
        taskRef: created[0]!.key,
      });
      assert.equal(byKey.kind, 'task');
      if (byKey.kind !== 'task') return;
      assert.equal(byKey.task?.id, created[0]!.id);
    } finally {
      await Promise.all([desktop?.close(), tui?.close()]);
      await fixture.stopHost(firstHost);
    }

    assert.ok(firstPage?.nextCursor);
    await fixture.updateTask(created[0]!.id, { subject: 'changed after Host restart' });

    const successor = await fixture.startHost();
    let successorClient: RuntimeHostConnection | undefined;
    try {
      successorClient = await connectClient(fixture.root, 'run');
      const stale = await successorClient.request('task.ledger.query', {
        kind: 'list_continue',
        sessionId: fixture.sessionId,
        revision: firstPage.revision,
        cursor: firstPage.nextCursor,
      });
      assert.equal(stale.kind, 'revision_changed');
      if (stale.kind !== 'revision_changed') return;
      assert.equal(stale.expected, firstPage.revision);
      assert.notEqual(stale.actual, firstPage.revision);
    } finally {
      await successorClient?.close();
      await fixture.stopHost(successor);
    }
  });
});

type Page = Extract<TaskLedgerQueryResult, { kind: 'page' }>;

async function queryFirstPage(client: RuntimeHostConnection, sessionId: string): Promise<Page> {
  const result = await client.request('task.ledger.query', { kind: 'list_start', sessionId });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') assert.fail('Task Ledger start query must return a page');
  return result;
}

async function collectTasks(client: RuntimeHostConnection, first: Page): Promise<Page['tasks']> {
  const tasks = [...first.tasks];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const result = await client.request('task.ledger.query', {
      kind: 'list_continue',
      sessionId: first.sessionId,
      revision: first.revision,
      cursor,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') assert.fail('Stable Task Ledger continuation must return a page');
    tasks.push(...result.tasks);
    cursor = result.nextCursor;
  }
  return tasks;
}
