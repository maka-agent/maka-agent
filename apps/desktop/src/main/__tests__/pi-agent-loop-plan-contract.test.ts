import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('pi agent loop migration plan contract', () => {
  it('keeps the source-grounded migration plan in the repo', async () => {
    const plan = await readRepo('notes/pr-pi-agent-loop-0-plan.md');

    assert.match(plan, /PR-PI-AGENT-LOOP-0/);
    assert.match(plan, /packages\/runtime\/src\/ai-sdk-backend\.ts/);
    assert.match(plan, /\/Users\/jakevin\/\.Trash\/alma-re\/docs\/20-acp\.md/);
    assert.match(plan, /\/Users\/jakevin\/\.Trash\/alma-re\/readable\/main\.js:20597-21460/);
  });

  it('requires a separate backend instead of overloading the current provider loop', async () => {
    const plan = await readRepo('notes/pr-pi-agent-loop-0-plan.md');

    assert.match(plan, /Add a separate backend kind for the pi loop/);
    assert.match(plan, /Keep `AiSdkBackend` available for fallback/);
    assert.match(plan, /Do not overload `backend: 'ai-sdk'` with process-backed behavior/);
  });

  it('pins permission and privacy boundaries before runtime exposure', async () => {
    const plan = await readRepo('notes/pr-pi-agent-loop-0-plan.md');

    assert.match(plan, /Every `session\/request_permission` must go through Maka's `PermissionEngine`/);
    assert.match(plan, /Bot \/ cron \/ background contexts must not silently auto-approve pi actions/);
    assert.match(plan, /Incognito sessions must not start a persistent pi session/);
    assert.match(plan, /Renderer\/preload must receive readiness state only/);
  });

  it('requires fake-transport tests before a visible backend selector', async () => {
    const plan = await readRepo('notes/pr-pi-agent-loop-0-plan.md');

    assert.match(plan, /fake process transport/);
    assert.match(plan, /fake `session\/update` stream maps into Maka events/);
    assert.match(plan, /fake `session\/request_permission` parks until user response/);
    assert.match(plan, /no Settings UI selector yet/);
  });
});
