import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FIRST_RUN_TASK_SUGGESTIONS,
  type FirstRunTaskSuggestionId,
} from '../../renderer/first-run-task-suggestions.js';

describe('FIRST_RUN_TASK_SUGGESTIONS', () => {
  it('keeps the first-run task rows small and stable', () => {
    assert.equal(FIRST_RUN_TASK_SUGGESTIONS.length, 4);
    assert.deepEqual(
      FIRST_RUN_TASK_SUGGESTIONS.map((suggestion) => suggestion.id),
      ['workspace-map', 'deep-research', 'file-organize', 'web-research'] satisfies FirstRunTaskSuggestionId[],
    );
  });

  it('uses concrete prompt copy rather than marketing labels', () => {
    for (const suggestion of FIRST_RUN_TASK_SUGGESTIONS) {
      assert.ok(
        suggestion.prompt.includes(suggestion.label.split('一个')[0].split('一下')[0]),
        `${suggestion.id} prompt should visibly relate to its label`,
      );
      assert.match(suggestion.prompt, /帮我|先/);
      assert.equal(suggestion.prompt.includes('Coming Soon'), false);
      assert.equal(suggestion.prompt.includes('TODO'), false);
    }
  });

  it('marks deep research as an explicit read-only mode', () => {
    const deepResearch = FIRST_RUN_TASK_SUGGESTIONS.find(
      (suggestion) => suggestion.id === 'deep-research',
    );
    assert.ok(deepResearch);
    assert.equal(deepResearch.mode, 'deep_research');
    assert.match(deepResearch.prompt, /只读/);
    assert.match(deepResearch.prompt, /不要修改文件/);
  });

  it('keeps file-management suggestions confirm-before-mutating', () => {
    const fileOrganize = FIRST_RUN_TASK_SUGGESTIONS.find(
      (suggestion) => suggestion.id === 'file-organize',
    );
    assert.ok(fileOrganize);
    assert.match(fileOrganize.prompt, /不要直接移动或删除文件/);
    assert.match(fileOrganize.prompt, /等我确认/);
  });

  it('surfaces project instruction creation in the first-run checklist', async () => {
    const source = await readFile(join(process.cwd(), 'src/renderer/FirstRunChecklist.tsx'), 'utf8');

    assert.match(source, /workspaceInstructions\.getState\(\)/);
    assert.match(source, /创建项目指令文件/);
    assert.match(source, /workspaceInstructionCount > 0/);
    assert.match(source, /onOpenSettingsSection\('memory'\)/);
  });
});
