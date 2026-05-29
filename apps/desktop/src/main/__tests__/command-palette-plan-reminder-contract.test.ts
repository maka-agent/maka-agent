import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('command palette plan reminder contract', () => {
  it('exposes a direct action for starting a new plan reminder', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette.tsx'), 'utf8');

    assert.match(src, /onStartPlanReminder\?\(\): void/);
    assert.match(src, /id:\s*'action:new-plan-reminder'/);
    assert.match(src, /label:\s*'新建计划提醒'/);
    assert.match(src, /hint:\s*'打开计划表单'/);
    assert.match(src, /run:\s*args\.onStartPlanReminder/);
  });

  it('wires the action to the shipped plan panel and focuses the title field', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'), 'utf8');
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');

    assert.match(main, /function\s+openPlanReminderForm\(\)/);
    assert.match(main, /setNavSelection\(\{\s*section:\s*'automations'\s*\}\)/);
    assert.match(main, /onStartPlanReminder:\s*openPlanReminderForm/);
    assert.match(main, /querySelector<HTMLInputElement>\('\[data-maka-plan-title-input="true"\]'\)/);
    assert.match(ui, /data-maka-plan-title-input="true"/);
  });
});
