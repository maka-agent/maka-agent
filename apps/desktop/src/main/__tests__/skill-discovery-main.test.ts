import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveDesktopSkillDiscoverySource } from '../skill-discovery-main.js';
import { SESSION_WORKSPACE_UNAVAILABLE_CODE } from '../project-context-root.js';

describe('resolveDesktopSkillDiscoverySource', () => {
  const workspaceRoot = '/maka-workspace';
  const skillHomeRoot = '/user-home';

  it('includes project, Maka workspace, and user sources when the session workspace is available', async () => {
    const source = await resolveDesktopSkillDiscoverySource({
      workspaceRoot,
      skillHomeRoot,
      getProjectRoot: async () => '/project',
    }, 'session-1');

    assert.deepEqual(source.entries.map(({ origin }) => origin), [
      'project_maka',
      'project_agents',
      'workspace',
      'user_maka',
      'user_agents',
    ]);
    assert.equal(source.entries[0]?.dir, join('/project', '.maka', 'skills'));
  });

  it('keeps global sources available when a historical session workspace is unavailable', async () => {
    const unavailable = new Error(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}: unavailable`);
    (unavailable as Error & { code: string }).code = SESSION_WORKSPACE_UNAVAILABLE_CODE;

    const source = await resolveDesktopSkillDiscoverySource({
      workspaceRoot,
      skillHomeRoot,
      getProjectRoot: async () => { throw unavailable; },
    }, 'historical-session');

    assert.deepEqual(source.entries.map(({ origin }) => origin), [
      'workspace',
      'user_maka',
      'user_agents',
    ]);
    assert.equal(source.entries[0]?.dir, join(workspaceRoot, 'skills'));
    assert.equal(source.stateRoot, workspaceRoot);
  });

  it('does not hide unrelated project-root failures', async () => {
    const failure = new Error('database unavailable');
    await assert.rejects(
      resolveDesktopSkillDiscoverySource({
        workspaceRoot,
        skillHomeRoot,
        getProjectRoot: async () => { throw failure; },
      }, 'session-1'),
      failure,
    );
  });
});
