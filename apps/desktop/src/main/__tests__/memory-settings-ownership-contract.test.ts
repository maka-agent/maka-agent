import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SETTINGS_ROOT = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings');

describe('Memory Settings ownership', () => {
  it('keeps document and workspace-instruction IPC in separate owners', async () => {
    const [page, documentOwner, instructionOwner] = await Promise.all([
      readFile(resolve(SETTINGS_ROOT, 'memory-settings-page.tsx'), 'utf8'),
      readFile(resolve(SETTINGS_ROOT, 'use-memory-settings-controller.ts'), 'utf8'),
      readFile(resolve(SETTINGS_ROOT, 'use-workspace-instructions-controller.ts'), 'utf8'),
    ]);

    assert.match(page, /useMemoryDocumentController/);
    assert.match(page, /useWorkspaceInstructionsController/);
    assert.doesNotMatch(documentOwner, /window\.maka\.workspaceInstructions/);
    assert.doesNotMatch(instructionOwner, /window\.maka\.memory/);
    assert.match(documentOwner, /runMemoryWriteAction\('restore'/);
    assert.match(instructionOwner, /runWriteAction\(`instruction:\$\{file\}:create`/);
  });

  it('keeps filtering and prompt-preview derivation pure', async () => {
    const viewModel = await readFile(resolve(SETTINGS_ROOT, 'memory-settings-view-model.ts'), 'utf8');

    assert.match(viewModel, /export function deriveMemorySettingsViewModel/);
    assert.match(viewModel, /parseLocalMemoryMarkdown/);
    assert.match(viewModel, /buildLocalMemoryPromptBody/);
    assert.doesNotMatch(viewModel, /window\.maka|useState|useEffect|useRef/);
  });
});
