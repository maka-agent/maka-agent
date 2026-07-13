import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLocalMemoryMarkdown, readLocalMemoryForAgent } from '../local-memory.js';

interface CompatibilityFixture {
  schemaVersion: 'maka.local_memory.compatibility_fixture.v1';
  cases: Array<{
    id: string;
    markdown: string;
    expected: {
      durableActive: number;
      compatibility: number;
      malformed: number;
      compatVisible: boolean;
      strictVisible: boolean;
    };
  }>;
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  '__tests__',
  'fixtures',
  'memory-markdown-compatibility-v1.json',
);

test('Markdown compatibility lifecycle fixture never false-promotes legacy or malformed entries', async () => {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as CompatibilityFixture;
  assert.equal(fixture.schemaVersion, 'maka.local_memory.compatibility_fixture.v1');
  assert.equal(fixture.cases.length, 5);

  for (const benchmarkCase of fixture.cases) {
    const parsed = parseLocalMemoryMarkdown(benchmarkCase.markdown);
    assert.equal(parsed.durableActiveEntries.length, benchmarkCase.expected.durableActive, benchmarkCase.id);
    assert.equal(parsed.compatibilityEntries.length, benchmarkCase.expected.compatibility, benchmarkCase.id);
    assert.equal(parsed.malformedEntries.length, benchmarkCase.expected.malformed, benchmarkCase.id);
    assert.ok(
      [...parsed.compatibilityEntries, ...parsed.malformedEntries].every((entry) => entry.status !== 'active'),
      `${benchmarkCase.id} exposed a non-durable entry as active`,
    );

    const compat = readLocalMemoryForAgent(benchmarkCase.markdown, readContext('workspace_compat'));
    const strict = readLocalMemoryForAgent(benchmarkCase.markdown, readContext('deny'));
    assert.equal(compat.status === 'visible', benchmarkCase.expected.compatVisible, benchmarkCase.id);
    assert.equal(strict.status === 'visible', benchmarkCase.expected.strictVisible, benchmarkCase.id);
  }
});

function readContext(legacyScopePolicy: 'workspace_compat' | 'deny') {
  return {
    workspaceRoot: '/workspace',
    sourceWorkspaceRoot: '/workspace',
    sessionId: 'session-a',
    enabled: true,
    agentReadEnabled: true,
    incognitoActive: false,
    legacyScopePolicy,
  } as const;
}
