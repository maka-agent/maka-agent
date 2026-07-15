import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  EXPERT_TEAM_LABEL_PREFIX,
  expertTeamIdFromLabels,
  expertTeamLabel,
  isExpertTeamSession,
} from '../expert-team.js';

describe('expert-team session labels', () => {
  it('builds a parameterized label', () => {
    assert.equal(expertTeamLabel('code-review'), 'mode:expert-team:code-review');
    assert.ok(expertTeamLabel('code-review').startsWith(EXPERT_TEAM_LABEL_PREFIX));
  });

  it('extracts the team id from labels', () => {
    assert.equal(expertTeamIdFromLabels([expertTeamLabel('code-review')]), 'code-review');
    assert.equal(expertTeamIdFromLabels(['other', expertTeamLabel('research')]), 'research');
    assert.equal(expertTeamIdFromLabels(['mode:deep_research']), undefined);
    assert.equal(expertTeamIdFromLabels([]), undefined);
    assert.equal(expertTeamIdFromLabels(undefined), undefined);
  });

  it('ignores a bare prefix with no team id', () => {
    assert.equal(expertTeamIdFromLabels([EXPERT_TEAM_LABEL_PREFIX]), undefined);
  });

  it('detects an expert-team session', () => {
    assert.equal(isExpertTeamSession([expertTeamLabel('code-review')]), true);
    assert.equal(isExpertTeamSession(['mode:deep_research']), false);
    assert.equal(isExpertTeamSession(undefined), false);
  });

  it('returns the first matching team id when several are present', () => {
    assert.equal(
      expertTeamIdFromLabels([expertTeamLabel('code-review'), expertTeamLabel('research')]),
      'code-review',
    );
  });
});
