import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('model catalog picker contract', () => {
  it('routes chat, settings, and daily review model choices through the catalog helper', async () => {
    const helper = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/model-catalog-choices.ts'),
      'utf8',
    );
    const main = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'),
      'utf8',
    );
    const providers = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/ProvidersPanel.tsx'),
      'utf8',
    );
    const settings = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/SettingsModal.tsx'),
      'utf8',
    );

    assert.match(helper, /buildConnectionModelCatalogEntries/);
    assert.match(main, /buildCatalogChatModelChoices\(connections\)/);
    assert.match(providers, /buildCatalogModelChoices\(/);
    assert.match(settings, /buildCatalogDailyReviewModelOptions\(/);
  });

  it('does not use connection.name for Daily Review model labels', async () => {
    const settings = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/SettingsModal.tsx'),
      'utf8',
    );
    const helper = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/model-catalog-choices.ts'),
      'utf8',
    );

    assert.match(settings, /buildDailyReviewModelOptions\(modelConnections, effectiveConfig\?\.modelKey \?\? ''\)/);
    assert.doesNotMatch(settings, /connectionName/);
    assert.doesNotMatch(helper, /connection\.name|connectionName/);
  });
});
