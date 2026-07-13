import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveMemorySettingsViewModel } from '../../renderer/settings/memory-settings-view-model.js';

describe('Memory Settings view model', () => {
  it('derives entry filtering and prompt preview from the visible draft', () => {
    const draft = [
      '# Maka Memory',
      '',
      '## Writing style',
      '<!-- maka-memory: id=writing origin=manual status=active tags=preference -->',
      'Prefer concise answers.',
      '',
      '## Old preference',
      '<!-- maka-memory: id=old origin=manual status=archived -->',
      'Use verbose answers.',
    ].join('\n');

    const result = deriveMemorySettingsViewModel({
      state: null,
      localMemorySettings: { enabled: true, agentReadEnabled: true },
      draft,
      query: 'concise',
    });

    assert.equal(result.memoryDraftDirty, true);
    assert.equal(result.visibleMemoryEntries.activeEntries.length, 1);
    assert.equal(result.visibleMemoryEntries.archivedEntries.length, 1);
    assert.deepEqual(result.filteredActiveEntries.map((entry) => entry.id), ['writing']);
    assert.equal(result.filteredArchivedEntries.length, 0);
    assert.match(result.localMemoryPromptPreview, /Prefer concise answers\./);
    assert.doesNotMatch(result.localMemoryPromptPreview, /Use verbose answers\./);
  });

  it('falls back to persisted settings before the document state loads', () => {
    const result = deriveMemorySettingsViewModel({
      state: null,
      localMemorySettings: { enabled: true, agentReadEnabled: false },
      draft: '',
      query: '  ',
    });

    assert.equal(result.effective.enabled, true);
    assert.equal(result.effective.agentReadEnabled, false);
    assert.equal(result.normalizedMemoryEntryQuery, '');
    assert.equal(result.promptPreviewWillInject, false);
  });
});
