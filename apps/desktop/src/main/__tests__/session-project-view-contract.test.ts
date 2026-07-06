import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { deriveProjectGroups } from '../../renderer/session-project-grouping.js';
import { makeSessionSummary, renderSessionListPanel } from './session-list-render-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('sidebar project view mode', () => {
  it('renders project groups, the unassigned bucket, and keeps the status fallback path', () => {
    const sessions = [
      makeSessionSummary({
        id: 'repo-session',
        name: 'Repo session',
        cwd: 'C:\\work\\repo-a',
        status: 'active',
        lastMessageAt: 3,
      }),
      makeSessionSummary({
        id: 'pending-session',
        name: 'Pending session',
        cwd: undefined,
        status: 'active',
        lastMessageAt: undefined,
      }),
    ];

    const projectMarkup = renderSessionListPanel({
      sessions,
      statusGroups: deriveProjectGroups(sessions),
      viewMode: 'project',
    });
    assert.match(projectMarkup, /repo-a/);
    assert.match(projectMarkup, /Pending session/);

    const fallbackMarkup = renderSessionListPanel({
      sessions: [sessions[1]],
    });
    assert.match(fallbackMarkup, /待发送/);
  });

  it('AppShell derives status and project groups from the same visible session set', async () => {
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const panel = await readRepo('packages/ui/src/session-list-panel.tsx');

    assert.match(appShell, /const visibleSessions = useMemo\(\(\) => filterSessions\(sessions, navSelection\), \[sessions, navSelection\]\)/);
    assert.match(appShell, /deriveSessionStatusGroups\(visibleSessions, \{ pinFirst: true \}\)/);
    assert.match(appShell, /deriveProjectGroups\(visibleSessions\)/);
    assert.match(appShell, /const sessionListGroups = viewMode === 'project' \? sessionProjectGroups : sessionStatusGroups/);
    assert.match(appShell, /statusGroups=\{sessionListGroups\}/);
    assert.doesNotMatch(appShell, /projectGroups=\{/);

    assert.doesNotMatch(panel, /projectGroups\?:/);
    assert.doesNotMatch(panel, /id: 'all'/);
  });

  it('project group ids stay DOM-safe and distinct when the cwd has spaces or shared basenames', () => {
    const sessions = [
      makeSessionSummary({ id: 'a', cwd: '/Users/me/My Project/repo-a' }),
      makeSessionSummary({ id: 'b', cwd: '/Users/me/Other/repo-a' }),
      makeSessionSummary({ id: 'c', cwd: 'C:\\work\\spaced dir\\x' }),
    ];
    const groups = deriveProjectGroups(sessions);
    const ids = groups.map((g) => g.id);

    // DOM id must contain no ASCII whitespace and only DOM-safe chars.
    for (const id of ids) {
      assert.match(id, /^[A-Za-z0-9:_-]+$/, `group id must be DOM-safe, got: ${id}`);
    }
    // Distinct paths collapse to distinct ids even with a shared basename.
    assert.equal(new Set(ids).size, ids.length, 'distinct cwds must produce distinct ids');
    // The human-readable label is still the basename.
    assert.ok(groups.some((g) => g.label === 'repo-a'), 'expected a repo-a label');
    assert.ok(groups.some((g) => g.label === 'x'), 'expected an x label');

    // Rendered markup: group body ids and aria-controls stay whitespace-free and pair up.
    const markup = renderSessionListPanel({
      sessions,
      statusGroups: groups,
      viewMode: 'project',
    });
    const bodyIds = [...markup.matchAll(/id="maka-list-group-body-([^"]*)"/g)].map((m) => m[1]);
    const controls = [...markup.matchAll(/aria-controls="maka-list-group-body-([^"]*)"/g)].map((m) => m[1]);
    assert.ok(bodyIds.length >= 3, `expected at least 3 group body ids, got ${bodyIds.length}`);
    for (const id of [...bodyIds, ...controls]) {
      assert.match(id, /^[A-Za-z0-9:_-]+$/, `rendered group id must be DOM-safe, got: ${id}`);
    }
    for (const control of controls) {
      assert.ok(bodyIds.includes(control), `aria-controls references a missing body id: ${control}`);
    }
  });
});
