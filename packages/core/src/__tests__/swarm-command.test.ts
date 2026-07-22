import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSwarmCommand } from '../swarm-command.js';

describe('/swarm parser', () => {
  test('parses bare and explicit status commands', () => {
    assert.deepEqual(parseSwarmCommand('/swarm'), { kind: 'status' });
    assert.deepEqual(parseSwarmCommand('  /swarm status  '), { kind: 'status' });
  });

  test('parses persistent mode changes only when the whole tail matches', () => {
    assert.deepEqual(parseSwarmCommand('/swarm on'), { kind: 'set_mode', mode: 'swarm' });
    assert.deepEqual(parseSwarmCommand('/swarm off'), { kind: 'set_mode', mode: 'default' });
    assert.deepEqual(parseSwarmCommand('/swarm on the repository'), {
      kind: 'run_once',
      task: 'on the repository',
    });
  });

  test('preserves a one-shot task as clean user text', () => {
    assert.deepEqual(parseSwarmCommand('/swarm inspect runtime, UI, and tests'), {
      kind: 'run_once',
      task: 'inspect runtime, UI, and tests',
    });
  });

  test('does not claim lookalike slash commands', () => {
    assert.equal(parseSwarmCommand('/swarming now'), null);
    assert.equal(parseSwarmCommand('please /swarm this'), null);
  });
});
