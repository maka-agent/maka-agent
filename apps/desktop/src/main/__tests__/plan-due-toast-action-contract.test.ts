import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('plan reminder due toast action contract', () => {
  it('lets users jump from a due reminder toast back to the plan list', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');

    assert.match(src, /subscribeDue\(\(reminder\)\s*=>\s*\{/);
    assert.match(src, /toastApi\.toast\(\{/);
    assert.match(src, /title:\s*'计划提醒'/);
    assert.match(src, /description:\s*reminder\.title/);
    assert.match(src, /label:\s*'查看计划'/);
    assert.match(src, /onClick:\s*\(\)\s*=>\s*setNavSelection\(\{\s*section:\s*'automations'\s*\}\)/);
    assert.doesNotMatch(src, /toastApi\.info\('计划提醒',\s*reminder\.title\)/);
  });
});
