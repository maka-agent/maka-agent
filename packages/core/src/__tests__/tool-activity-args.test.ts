import assert from 'node:assert/strict';
import { it } from 'node:test';

import { projectToolActivityArgs } from '../index.js';

it('projects WriteStdin activity without exposing raw input', () => {
  const projected = projectToolActivityArgs('WriteStdin', {
    ref: 'maka://runtime/background-tasks/one',
    input: '中\r',
    size: { cols: 100, rows: 30 },
    yield_time_ms: 0,
  });
  assert.deepEqual(projected, {
    ref: 'maka://runtime/background-tasks/one',
    inputBytes: 4,
    size: { cols: 100, rows: 30 },
    yield_time_ms: 0,
  });
  assert.doesNotMatch(JSON.stringify(projected), /中/);
  assert.deepEqual(projectToolActivityArgs('WriteStdin', projected), projected);
  assert.deepEqual(projectToolActivityArgs('WriteStdin', 'malformed raw input'), {});
});
