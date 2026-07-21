import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stableLocalMemoryEntryId } from '@maka/core/local-memory';
import { buildBuiltinTools } from '@maka/runtime';
import { openInteractiveMemoryStoreForWrite } from '@maka/storage/memory-store';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-store';
import { createHostExecutionModelComposition } from '../server/execution-model-composition.js';
import { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';
import { HostSkillCatalogFilesystem } from '../server/skill-catalog-filesystem.js';

const SESSION_ID = 'model-composition-session';
const NOW = 1_700_000_000_000;

test('composes only canonical Host model context in the fixed order', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-model-composition-'));
  const root = join(base, 'root');
  const managedSources = join(base, 'managed-sources');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const memoryStore = await openInteractiveMemoryStoreForWrite(owner.lease);
  const taskLedger = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
  const skills = new HostSkillCatalogCoordinator(
    new HostSkillCatalogFilesystem(owner.lease, managedSources),
  );
  const memory = new HostMemoryCoordinator(memoryStore, policyStores.runtimePolicy, () => NOW);

  try {
    await mkdir(join(root, 'skills', 'canonical-skill'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'canonical-skill', 'SKILL.md'),
      skillDocument('Canonical Skill', 'Read from the Host snapshot', 'FIRST_BODY', ['Bash']),
      'utf8',
    );
    await writeFile(join(root, 'AGENTS.md'), 'WORKSPACE_INSTRUCTION_SENTINEL\n', 'utf8');
    await skills.recover();

    const recoveredScan = skills.readCanonicalModelSkills();
    assert.equal(recoveredScan.length, 1);
    assert.equal(recoveredScan[0]?.content.trim(), 'FIRST_BODY');
    assert.equal(recoveredScan[0]?.content.includes('name: Canonical Skill'), false);
    assert.equal(Object.isFrozen(recoveredScan), true);
    assert.equal(Object.isFrozen(recoveredScan[0]), true);

    await writeFile(
      join(root, 'skills', 'canonical-skill', 'SKILL.md'),
      skillDocument('Canonical Skill', 'Changed outside the snapshot', 'SECOND_BODY', ['Bash']),
      'utf8',
    );
    assert.equal(skills.readCanonicalModelSkills()[0]?.content.trim(), 'FIRST_BODY');

    const memoryContent = memoryDocument('MEMORY_SENTINEL');
    await memoryStore.save({ expectedRevision: null, bytes: Buffer.from(memoryContent) });

    const initialPolicy = await policyStores.runtimePolicy.getSnapshot();
    assert.equal(await memory.readCanonicalModelPrompt(initialPolicy.policy), undefined);
    const personalized = await policyStores.runtimePolicy.mutate({
      expectedRevision: initialPolicy.revision,
      operation: {
        kind: 'set_personalization',
        value: { displayName: 'Canonical User', assistantTone: 'COMPOSITION_TONE_SENTINEL' },
      },
    });
    assert.equal(personalized.kind, 'committed');
    if (personalized.kind !== 'committed') return;
    const memoryEnabled = await policyStores.runtimePolicy.mutate({
      expectedRevision: personalized.snapshot.revision,
      operation: { kind: 'set_memory', value: { enabled: true, agentReadEnabled: true } },
    });
    assert.equal(memoryEnabled.kind, 'committed');
    if (memoryEnabled.kind !== 'committed') return;

    await taskLedger.create(SESSION_ID, [{ subject: 'TASK_LEDGER_SENTINEL' }]);

    const bashTool = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    assert.ok(bashTool);
    const composition = createHostExecutionModelComposition({
      policy: policyStores.runtimePolicy,
      skills,
      memory,
      taskLedger,
      runtimeTools: [bashTool],
      platform: 'linux',
      shell: 'test-shell',
      now: () => new Date('2026-07-21T00:00:00Z'),
    });
    assert.deepEqual(
      composition.tools.map((tool) => tool.name),
      ['AskUserQuestion', 'Skill', 'task_create', 'task_update', 'task_list', 'task_get', 'Bash'],
    );

    const context = { sessionId: SESSION_ID, cwd: root };
    const system = await composition.systemPrompt(context);
    assert.ok(system);
    assertOrdered(system, [
      'COMPOSITION_TONE_SENTINEL',
      'Canonical Skill',
      'WORKSPACE_INSTRUCTION_SENTINEL',
      'MEMORY_SENTINEL',
    ]);
    assert.equal(system.includes('SECOND_BODY'), false);

    await skills.recover();
    const loaded = (await composition.tools[1]!.impl(
      { name: 'canonical-skill' },
      {
        sessionId: SESSION_ID,
        turnId: 'model-composition-turn',
        cwd: root,
        toolCallId: 'skill-call',
        abortSignal: new AbortController().signal,
        emitOutput: () => undefined,
      },
    )) as { readonly ok: boolean; readonly skill?: { readonly instructions: string } };
    assert.equal(loaded.ok, true);
    assert.equal(loaded.skill?.instructions.trim(), 'SECOND_BODY');

    const tail = await composition.turnTailPrompt(context);
    assertOrdered(tail, ['Maka session environment', 'TASK_LEDGER_SENTINEL']);
    assert.equal(tail.includes('<local-memory>'), false);

    const latestPolicy = await policyStores.runtimePolicy.getSnapshot();
    const disabled = await policyStores.runtimePolicy.mutate({
      expectedRevision: latestPolicy.revision,
      operation: { kind: 'set_memory', value: { enabled: false, agentReadEnabled: true } },
    });
    assert.equal(disabled.kind, 'committed');
    if (disabled.kind !== 'committed') return;
    assert.equal(await memory.readCanonicalModelPrompt(disabled.snapshot.policy), undefined);
    const reenabled = await policyStores.runtimePolicy.mutate({
      expectedRevision: disabled.snapshot.revision,
      operation: { kind: 'set_memory', value: { enabled: true, agentReadEnabled: true } },
    });
    assert.equal(reenabled.kind, 'committed');
    if (reenabled.kind !== 'committed') return;
    const incognito = await policyStores.runtimePolicy.mutate({
      expectedRevision: reenabled.snapshot.revision,
      operation: { kind: 'set_privacy', value: { incognitoActive: true } },
    });
    assert.equal(incognito.kind, 'committed');
    if (incognito.kind !== 'committed') return;
    assert.equal(await memory.readCanonicalModelPrompt(incognito.snapshot.policy), undefined);

    const visibleAgain = await policyStores.runtimePolicy.mutate({
      expectedRevision: incognito.snapshot.revision,
      operation: { kind: 'set_privacy', value: { incognitoActive: false } },
    });
    assert.equal(visibleAgain.kind, 'committed');
    if (visibleAgain.kind !== 'committed') return;
    assert.ok(
      (await memory.readCanonicalModelPrompt(visibleAgain.snapshot.policy))?.includes(
        'MEMORY_SENTINEL',
      ),
    );

    const advancingPolicy = {
      getSnapshot: async () => {
        const snapshot = await policyStores.runtimePolicy.getSnapshot();
        if (!snapshot.policy.privacy.incognitoActive) {
          const advanced = await policyStores.runtimePolicy.mutate({
            expectedRevision: snapshot.revision,
            operation: { kind: 'set_privacy', value: { incognitoActive: true } },
          });
          assert.equal(advanced.kind, 'committed');
        }
        return snapshot;
      },
    };
    const coherentComposition = createHostExecutionModelComposition({
      policy: advancingPolicy,
      skills,
      memory,
      taskLedger,
      runtimeTools: [bashTool],
    });
    const coherentSystem = await coherentComposition.systemPrompt(context);
    assert.ok(coherentSystem);
    assert.ok(coherentSystem.includes('COMPOSITION_TONE_SENTINEL'));
    assert.ok(coherentSystem.includes('MEMORY_SENTINEL'));
    assert.equal(
      (await policyStores.runtimePolicy.getSnapshot()).policy.privacy.incognitoActive,
      true,
    );
  } finally {
    skills.beginDrain();
    await skills.close();
    await memoryStore.beginDrain();
    await memoryStore.close();
    owner.beginClose();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function skillDocument(
  name: string,
  description: string,
  body: string,
  requiredTools: readonly string[] = [],
): string {
  const requirements =
    requiredTools.length > 0 ? `required-tools: [${requiredTools.join(', ')}]\n` : '';
  return `---\nname: ${name}\ndescription: ${description}\n${requirements}---\n${body}\n`;
}

function memoryDocument(content: string): string {
  const id = stableLocalMemoryEntryId(content, NOW);
  return [
    '# Maka Memory',
    '',
    '## Canonical preference',
    `<!-- maka-memory: id=${id} origin=manual createdAt=${NOW} status=active -->`,
    content,
    '',
  ].join('\n');
}

function assertOrdered(source: string, sentinels: readonly string[]): void {
  let previous = -1;
  for (const sentinel of sentinels) {
    const current = source.indexOf(sentinel);
    assert.ok(current > previous, `${sentinel} must follow the previous fragment`);
    previous = current;
  }
}
