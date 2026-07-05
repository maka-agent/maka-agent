import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildSessionEnvironmentPromptFragment } from '../system-prompt/session-environment-prompt.js';

describe('session environment prompt date', () => {
  it('uses the configured timezone for "Today\'s date" so a UTC instant near local midnight is not off by one', () => {
    // 2026-05-29T16:30:00Z in Asia/Shanghai (UTC+8) is 2026-05-30 00:30 local.
    // A UTC-based formatter would report 2026-05-29 (wrong); the local date is 2026-05-30.
    const prompt = buildSessionEnvironmentPromptFragment({
      cwd: '/repo',
      projectGit: { isGitRepo: true, branch: 'main' },
      platform: 'darwin',
      now: new Date('2026-05-29T16:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });
    assert.match(prompt, /Today's date: 2026-05-30/);
  });

  it('keeps the same calendar day when the timezone is UTC and the instant is midday UTC', () => {
    const prompt = buildSessionEnvironmentPromptFragment({
      cwd: '/repo',
      projectGit: { isGitRepo: true, branch: 'main' },
      platform: 'darwin',
      now: new Date('2026-05-29T12:34:56.000Z'),
      timeZone: 'UTC',
    });
    assert.match(prompt, /Today's date: 2026-05-29/);
  });
});