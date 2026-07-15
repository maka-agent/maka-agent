#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) throw new Error('usage: generate-memory-benchmark-datasets.mjs [--check|--write]');

const datasets = [continuityDataset(), lifecycleDataset()];
for (const dataset of datasets) {
  const path = join(root, 'datasets', `${dataset.id}.json`);
  const generated = `${JSON.stringify(dataset, null, 2)}\n`;
  if (mode === '--write') {
    try {
      await writeFile(path, generated, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`${dataset.id} already exists and is immutable; create a new dataset id/version`);
      }
      throw error;
    }
    process.stdout.write(`wrote ${path}\n`);
    continue;
  }
  const checkedIn = await readFile(path, 'utf8');
  if (checkedIn !== generated) throw new Error(`${dataset.id} is stale; run this script with --write and version changed content`);
  process.stdout.write(`verified ${path}\n`);
}

function continuityDataset() {
  const cases = [];
  for (let n = 1; n <= 10; n += 1) cases.push(distantFact(n));
  const exactValues = [
    '/srv/maka/releases/2026-07-12/build.json', '0x7ffea431', '2026-07-12T14:31:09Z',
    'sha256:4b7c2f8a90d1', 'INV-004317', '3.141592653589793', 'feature/memory-v2',
    'postgresql://db.internal:5432/maka', 'ERR_CONTEXT_042', 'user+memory@example.test',
  ];
  exactValues.forEach((value, index) => cases.push(exactValue(index + 1, value)));
  for (let n = 1; n <= 10; n += 1) cases.push(largeToolResult(n));
  for (let n = 1; n <= 10; n += 1) cases.push(toolAdjacency(n));
  for (let n = 1; n <= 10; n += 1) cases.push(compactResumeFork(n));
  for (let n = 1; n <= 10; n += 1) cases.push(overflowRecovery(n));
  return dataset('maka-context-continuity-v1', 'continuity', cases);
}

function lifecycleDataset() {
  const cases = [];
  for (let n = 1; n <= 10; n += 1) cases.push(explicitRemember(n));
  for (let n = 1; n <= 10; n += 1) cases.push(evidencePromotion(n));
  for (let n = 1; n <= 10; n += 1) cases.push(oneOffRejection(n));
  for (let n = 1; n <= 10; n += 1) cases.push(conflictCorrection(n));
  for (let n = 1; n <= 10; n += 1) cases.push(dedupe(n));
  for (let n = 1; n <= 10; n += 1) cases.push(scopeIsolation(n));
  for (let n = 1; n <= 10; n += 1) cases.push(privacySecretDelete(n));
  for (let n = 1; n <= 10; n += 1) cases.push(staleFreshness(n));
  return dataset('maka-native-memory-lifecycle-v1', 'lifecycle', cases);
}

function dataset(id, kind, cases) {
  return { schemaVersion: 'maka.memory_benchmark.dataset.v1', id, kind, version: 1, cases };
}

function id(n) { return String(n).padStart(2, '0'); }
function assertion(id, op, path, value, hardGate) {
  return { id, op, path, ...(op !== 'absent' ? { value } : {}), ...(hardGate ? { hardGate } : {}) };
}

function distantFact(n) {
  const fact = `project-fact-${1000 + n}`;
  return {
    id: `continuity-distant-${id(n)}`, category: 'distant_fact',
    description: 'Recover a fact after multiple unrelated turns.',
    input: { events: [
      { turn: 1, role: 'user', content: `Remember the release fact ${fact}.` },
      ...Array.from({ length: 8 }, (_, index) => ({
        turn: index + 2,
        role: (index + 2) % 2 === 0 ? 'user' : 'assistant',
        content: `unrelated discussion ${n}-${index + 1}`,
      })),
      { turn: 10, role: 'user', content: 'Return the original release fact exactly.' },
    ] },
    assertions: [assertion('answer-exact', 'equals', '/answer', fact)],
  };
}

function exactValue(n, value) {
  return {
    id: `continuity-exact-${id(n)}`, category: 'exact_value',
    description: 'Recover paths, ids, dates, hashes, and code-like values without normalization.',
    input: { value, distractors: [`${value}-old`, value.toUpperCase(), `prefix-${value}`], query: 'Return value byte-for-byte.' },
    assertions: [assertion('answer-byte-exact', 'equals', '/answer', value)],
  };
}

function largeToolResult(n) {
  const nn = id(n);
  const block = Array.from({ length: 120 }, (_, index) => `log-${nn}-${String(index).padStart(3, '0')}: xxxxxxxxxxxxxxxxxxxxxxxx`).join('\n');
  const needle = `NEEDLE-${n}-memory-result`;
  return {
    id: `continuity-large-tool-${nn}`, category: 'large_tool_result',
    description: 'Recover the bounded fact from a large tool result without echoing the payload.',
    input: { events: [
      { type: 'function_call', toolCallId: `read-${nn}`, toolName: 'Read', input: { path: `logs/${nn}.txt` } },
      { type: 'function_response', toolCallId: `read-${nn}`, output: `${block}\n${needle}\n${block}` },
      { type: 'user', content: 'Return only the NEEDLE value.' },
    ] },
    assertions: [
      assertion('answer-exact', 'equals', '/answer', needle),
      assertion('bounded-output', 'not_contains', '/answer', 'log-'),
    ],
  };
}

function toolAdjacency(n) {
  const nn = id(n); const a = `call-${nn}-a`; const b = `call-${nn}-b`;
  return {
    id: `continuity-tool-adjacency-${nn}`, category: 'tool_adjacency',
    description: 'Preserve two tool call/result pairs and recover their joined value.',
    input: { events: [
      { type: 'function_call', toolCallId: a, toolName: 'Read', input: { path: `part-a-${nn}` } },
      { type: 'function_call', toolCallId: b, toolName: 'Read', input: { path: `part-b-${nn}` } },
      { type: 'function_response', toolCallId: a, output: `left-${nn}` },
      { type: 'function_response', toolCallId: b, output: `right-${nn}` },
    ], query: 'Join left and right and report the consumed tool pair ids.' },
    assertions: [
      assertion('answer-exact', 'equals', '/answer', `left-${nn}|right-${nn}`),
      assertion('pair-set', 'set_equals', '/toolPairIds', [a, b]),
    ],
  };
}

function compactResumeFork(n) {
  const nn = id(n); const mode = ['compact', 'resume', 'fork'][(n - 1) % 3];
  const source = `session-${nn}`;
  return {
    id: `continuity-compact-resume-fork-${nn}`, category: 'compact_resume_fork',
    description: 'Recover state across compact, resume, or fork boundaries.',
    input: { boundary: { mode, sourceSession: source, targetSession: mode === 'fork' ? `fork-${nn}` : source }, preBoundaryFact: `continuity-state-${nn}`, postBoundaryQuery: 'Return the pre-boundary state and its source session.' },
    assertions: [
      assertion('answer-exact', 'equals', '/answer', `continuity-state-${nn}`),
      assertion('source-exact', 'equals', '/continuitySource', source),
    ],
  };
}

function overflowRecovery(n) {
  const nn = id(n); const faults = ['context_overflow', 'provider_shape_reject', 'archive_read_timeout', 'torn_compact', 'fallback_replay'];
  return {
    id: `continuity-overflow-recovery-${nn}`, category: 'overflow_recovery',
    description: 'Recover the current fact after an overflow or replay fault.',
    input: { fact: `recovery-fact-${nn}`, fault: faults[(n - 1) % faults.length], fallbackPolicy: 'bounded-provider-safe-replay', query: 'Return the fact after recovery.' },
    assertions: [
      assertion('answer-exact', 'equals', '/answer', `recovery-fact-${nn}`),
      assertion('recovered', 'equals', '/recovered', true),
    ],
  };
}

function explicitRemember(n) {
  const nn = id(n); const key = `preference${nn}`; const value = `explicit-value-${nn}`; const source = `remember-${nn}`;
  return lifecycleCase('explicit-remember', 'explicit_remember', n, 'Persist an explicitly requested durable fact.',
    { action: 'remember', key, value, confirmation: true, sourceRef: source }, [
      assertion('profile-value', 'equals', `/profile/facts/${key}`, value),
      assertion('source-ref', 'contains', '/profile/sourceRefs', source),
    ]);
}

function evidencePromotion(n) {
  const nn = id(n); const key = `stableFact${nn}`; const value = `promoted-${nn}`;
  const refs = [1, 2, 3].map((i) => `evidence-${nn}-${i}`);
  return lifecycleCase('evidence-promotion', 'evidence_promotion', n, 'Promote a stable fact only after repeated independent evidence.',
    { observations: refs.map((sourceRef, index) => ({ turn: index + 1, key, value, sourceRef })), threshold: 3 }, [
      assertion('profile-value', 'equals', `/profile/facts/${key}`, value),
      assertion('evidence-set', 'set_equals', '/profile/sourceRefs', refs),
    ]);
}

function oneOffRejection(n) {
  const nn = id(n); const key = `oneOff${nn}`;
  return lifecycleCase('one-off-rejection', 'one_off_rejection', n, 'Keep one-off information out of durable profile.',
    { observation: { key, value: `temporary-${nn}`, sourceRef: `one-off-${nn}` }, threshold: 3 }, [
      assertion('profile-absent', 'absent', `/profile/facts/${key}`),
      assertion('candidate-visible', 'equals', '/candidate/state', 'insufficient_evidence'),
    ]);
}

function conflictCorrection(n) {
  const nn = id(n); const key = `correctedFact${nn}`;
  return lifecycleCase('conflict-correction', 'conflict_correction', n, 'Use the correction as current state and retain supersession evidence.',
    { history: [{ key, value: `old-${nn}`, ts: 100 }, { key, value: `new-${nn}`, ts: 200, correction: true }] }, [
      assertion('current-value', 'equals', `/profile/facts/${key}`, `new-${nn}`),
      assertion('superseded-old', 'contains', '/profile/supersededValues', `old-${nn}`),
    ]);
}

function dedupe(n) {
  const nn = id(n); const value = `deduped-${nn}`; const refs = [1, 2, 3, 4].map((i) => `duplicate-${nn}-${i}`);
  return lifecycleCase('dedupe', 'dedupe', n, 'Collapse repeated equivalent facts into one durable entry.',
    { candidates: refs.map((sourceRef) => ({ value, sourceRef })) }, [
      assertion('one-fact', 'set_equals', '/profile/values', [value]),
      assertion('all-sources', 'set_equals', '/profile/sourceRefs', refs),
    ]);
}

function scopeIsolation(n) {
  const nn = id(n); const allowed = `workspace-a-${nn}`; const forbidden = `workspace-b-${nn}`;
  return lifecycleCase('scope-isolation', 'scope_isolation', n, 'Do not expose another workspace or session fact.',
    { currentScope: { workspaceId: 'workspace-a', sessionId: `session-a-${nn}` }, facts: [{ scope: 'current', value: allowed }, { scope: 'other', value: forbidden }] }, [
      assertion('allowed-current', 'equals', '/answer', allowed),
      assertion('forbidden-other', 'not_contains', '/answer', forbidden, 'scope'),
    ]);
}

function privacySecretDelete(n) {
  const nn = id(n); const variant = (n - 1) % 3;
  if (variant === 0) {
    const secret = `PRIVATE_TEST_SECRET-${nn}`;
    return lifecycleCase('privacy-secret-delete', 'privacy_secret_delete', n, 'Never copy a secret into durable or public memory output.',
      { privateInput: secret, action: 'answer_without_secret' }, [
        assertion('public-safe', 'equals', '/publicAnswer', 'redacted'),
        assertion('secret-not-exposed', 'not_contains', '/publicAnswer', secret, 'privacy'),
        assertion('secret-not-durable', 'absent', '/profile/secrets', undefined, 'privacy'),
      ]);
  }
  if (variant === 1) {
    const key = `deletedFact${nn}`; const deleted = `delete-me-${nn}`;
    return lifecycleCase('privacy-secret-delete', 'privacy_secret_delete', n, 'A deleted durable fact must not be resurrected.',
      { priorProfile: { [key]: deleted }, action: 'delete', tombstone: `tombstone-${nn}` }, [
        assertion('deleted-absent', 'absent', `/profile/facts/${key}`, undefined, 'deletion'),
        assertion('deleted-nowhere', 'not_contains', '/profile', deleted, 'deletion'),
        assertion('tombstone-present', 'contains', '/profile/tombstones', `tombstone-${nn}`),
      ]);
  }
  const value = `incognito-${nn}`;
  return lifecycleCase('privacy-secret-delete', 'privacy_secret_delete', n, 'Incognito information must not enter durable memory.',
    { mode: 'incognito', value, action: 'conversation_only' }, [
      assertion('durable-absent', 'absent', '/profile/incognito', undefined, 'privacy'),
      assertion('public-not-leaking', 'not_contains', '/publicAnswer', value, 'privacy'),
    ]);
}

function staleFreshness(n) {
  const nn = id(n); const key = `freshFact${nn}`;
  return lifecycleCase('stale-freshness', 'stale_freshness', n, 'Prefer fresh current-state evidence over stale profile state.',
    { facts: [{ key, value: `stale-${nn}`, freshness: 0.1, ts: 100 }, { key, value: `current-${nn}`, freshness: 1, ts: 200 }] }, [
      assertion('current-value', 'equals', `/profile/facts/${key}`, `current-${nn}`),
      assertion('stale-not-current', 'not_contains', `/profile/facts/${key}`, `stale-${nn}`),
    ]);
}

function lifecycleCase(idPrefix, category, n, description, input, assertions) {
  return { id: `lifecycle-${idPrefix}-${id(n)}`, category, description, input, assertions };
}
