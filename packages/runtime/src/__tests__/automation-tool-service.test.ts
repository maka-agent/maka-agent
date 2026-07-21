import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AutomationManager,
  buildAutomationTool,
  buildAutomationToolFromService,
  createAutomationManagerToolService,
  type AutomationToolProjection,
  type AutomationToolService,
} from '../index.js';
import type { MakaToolContext } from '../tool-runtime.js';

function context(sessionId: string): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn-1',
    cwd: '/tmp/test',
    toolCallId: 'call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function projection(overrides: Partial<AutomationToolProjection> = {}): AutomationToolProjection {
  return {
    id: 'auto-1',
    kind: 'heartbeat',
    name: 'deploy check',
    status: 'active',
    schedule: { type: 'interval', seconds: 30 },
    nextFireAt: 1_700_000_030_000,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    lastError: null,
    consecutiveFailures: 0,
    durable: false,
    deferredFireCount: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function unused(): never {
  throw new Error('unexpected service operation');
}

describe('Automation service-backed tool', () => {
  test('embedded adapter mutates the manager and notifies before its promise settles', async () => {
    const manager = new AutomationManager({
      generateId: () => 'embedded-auto',
      now: () => 1_700_000_000_000,
      random: () => 0,
    });
    let changes = 0;
    const tool = buildAutomationTool({
      automationManager: manager,
      onAutomationChange: () => {
        changes++;
      },
    });

    const completion = tool.impl(
      {
        mode: 'create',
        kind: 'heartbeat',
        name: 'embedded check',
        prompt: 'check now',
        schedule: { type: 'interval', seconds: 30 },
      },
      context('embedded-session'),
    );

    assert.equal(manager.listForSession('embedded-session').length, 1);
    assert.equal(changes, 1);
    assert.match(await completion, /^Automation created: "embedded check"/);
  });

  test('embedded adapter reports callback failures as rejected promises after mutation', async () => {
    const manager = new AutomationManager({
      generateId: () => 'embedded-auto',
      now: () => 1_700_000_000_000,
      random: () => 0,
    });
    const service = createAutomationManagerToolService({
      automationManager: manager,
      onAutomationChange: () => {
        assert.equal(manager.listForSession('embedded-session').length, 1);
        throw new Error('persistence callback failed');
      },
    });

    const completion = service.create({
      requester: { sessionId: 'embedded-session' },
      kind: 'heartbeat',
      name: 'embedded check',
      prompt: 'check now',
      schedule: { type: 'interval', seconds: 30 },
    });

    await assert.rejects(completion, /persistence callback failed/);
  });

  test('embedded resume does not expose an exhausted automation from another session', async () => {
    const manager = new AutomationManager({
      generateId: () => 'private-auto',
      now: () => 1_700_000_000_000,
      random: () => 0,
    });
    const created = manager.create({
      kind: 'heartbeat',
      name: 'private check',
      prompt: 'check now',
      sessionId: 'owner-session',
      schedule: { type: 'interval', seconds: 30 },
      maxFires: 1,
    });
    assert.ok(!('error' in created));
    assert.ok(manager.attemptStarted(created.id));
    manager.attemptFailed(created.id, 'failed');

    const service = createAutomationManagerToolService({ automationManager: manager });
    const result = await service.resume({
      requester: { sessionId: 'other-session' },
      id: created.id,
    });

    assert.deepEqual(result, { outcome: 'not_found_or_invalid' });
  });

  test('awaits create, passes the current session, and formats the service projection', async () => {
    const completion = deferred<Awaited<ReturnType<AutomationToolService['create']>>>();
    let requesterSessionId: string | undefined;
    const service: AutomationToolService = {
      create: (request) => {
        requesterSessionId = request.requester.sessionId;
        return completion.promise;
      },
      delete: unused,
      list: unused,
      pause: unused,
      resume: unused,
    };
    const tool = buildAutomationToolFromService({ automationService: service });

    let settled = false;
    const outputPromise = Promise.resolve(
      tool.impl(
        {
          mode: 'create',
          kind: 'heartbeat',
          name: 'deploy check',
          prompt: 'check deploy',
          schedule: { type: 'interval', seconds: 30 },
        },
        context('current-session'),
      ),
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(requesterSessionId, 'current-session');

    completion.resolve({ outcome: 'created', automation: projection() });
    const output = await outputPromise;
    assert.match(output, /^Automation created: "deploy check" \(heartbeat\)/);
    assert.match(output, /ID: auto-1/);
    assert.match(output, /Schedule: every 30s/);
    assert.match(output, /Fires into this session\./);
  });

  test('awaits each by-id mutation before returning model output', async () => {
    const deleteCompletion = deferred<Awaited<ReturnType<AutomationToolService['delete']>>>();
    const pauseCompletion = deferred<Awaited<ReturnType<AutomationToolService['pause']>>>();
    const resumeCompletion = deferred<Awaited<ReturnType<AutomationToolService['resume']>>>();
    const assertRequest = (request: { requester: { sessionId: string }; id: string }) => {
      assert.deepEqual(request, {
        requester: { sessionId: 'mutation-session' },
        id: 'auto-1',
      });
    };
    const service: AutomationToolService = {
      create: unused,
      delete: (request) => {
        assertRequest(request);
        return deleteCompletion.promise;
      },
      list: unused,
      pause: (request) => {
        assertRequest(request);
        return pauseCompletion.promise;
      },
      resume: (request) => {
        assertRequest(request);
        return resumeCompletion.promise;
      },
    };
    const tool = buildAutomationToolFromService({ automationService: service });
    const cases = [
      {
        input: { mode: 'delete' as const, id: 'auto-1' },
        settle: () => deleteCompletion.resolve({ outcome: 'deleted' }),
        expected: 'Automation "auto-1" deleted.',
      },
      {
        input: { mode: 'pause' as const, id: 'auto-1' },
        settle: () => pauseCompletion.resolve({ outcome: 'paused', automation: projection() }),
        expected: 'Automation "deploy check" paused. Use mode "resume" to reactivate.',
      },
      {
        input: { mode: 'resume' as const, id: 'auto-1' },
        settle: () => resumeCompletion.resolve({ outcome: 'resumed', automation: projection() }),
        expectedPrefix: 'Automation "deploy check" resumed. Next fire:',
      },
    ];

    for (const testCase of cases) {
      let settled = false;
      const outputPromise = Promise.resolve(
        tool.impl(testCase.input, context('mutation-session')),
      ).then((output) => {
        settled = true;
        return output;
      });

      await Promise.resolve();
      assert.equal(settled, false, `${testCase.input.mode} settled before its mutation`);
      testCase.settle();
      const output = await outputPromise;
      if (testCase.expected) assert.equal(output, testCase.expected);
      if (testCase.expectedPrefix) assert.ok(output.startsWith(testCase.expectedPrefix));
    }
  });

  test('uses the same projection format for list and maps rejected promises to a stable error', async () => {
    const service: AutomationToolService = {
      create: unused,
      delete: unused,
      list: async (request) => {
        assert.equal(request.requester.sessionId, 'list-session');
        return [
          projection({
            status: 'paused',
            fireCount: 2,
            maxFires: 5,
            deferredFireCount: 1,
          }),
        ];
      },
      pause: unused,
      resume: async () => {
        throw new Error('transport internals must not leak');
      },
    };
    const tool = buildAutomationToolFromService({ automationService: service });

    const listOutput = await tool.impl({ mode: 'list' }, context('list-session'));
    assert.match(listOutput, /^\[PAUSED\] deploy check \(heartbeat\)/);
    assert.match(listOutput, /Fires: 2\/5 \(deferred 1 attempt\(s\) while busy\)/);

    const errorOutput = await tool.impl({ mode: 'resume', id: 'auto-1' }, context('list-session'));
    assert.equal(errorOutput, 'Error: Automation service request failed.');
  });
});
