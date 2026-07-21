import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { skillInvocationDisplayText } from '../../renderer/skill-invocation-feedback.js';

describe('Desktop Skill invocation display text', () => {
  it('preserves user text when the send also loaded Skills', () => {
    assert.equal(
      skillInvocationDisplayText('  keep spacing  ', {
        loaded: [{ id: 'alpha', name: 'Alpha' }],
        failed: [],
      }),
      '  keep spacing  ',
    );
  });

  it('renders loaded ids for a chip-only optimistic message', () => {
    assert.equal(
      skillInvocationDisplayText('', {
        loaded: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: 'Beta' },
        ],
        failed: [],
      }),
      '/skill:alpha /skill:beta',
    );
  });
});
