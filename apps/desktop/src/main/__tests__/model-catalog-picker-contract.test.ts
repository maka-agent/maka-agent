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

  it('lets the main Daily Review panel choose and pass a model for manual runs', async () => {
    const ui = await readFile(
      resolve(REPO_ROOT, 'packages/ui/src/components.tsx'),
      'utf8',
    );
    const main = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/main.tsx'),
      'utf8',
    );
    const preload = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'),
      'utf8',
    );
    const mainProcess = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'),
      'utf8',
    );

    assert.match(ui, /modelOptions\?:\s*ReadonlyArray<SettingsSelectOption<string>>/);
    assert.match(ui, /<SettingsSelect[\s\S]*ariaLabel="每日回顾分析模型"[\s\S]*onChange=\{setSelectedModelKey\}/);
    assert.match(ui, /runOnce\(\{\s*mode,\s*modelKey:\s*selectedModelKey/);
    assert.match(main, /buildCatalogDailyReviewModelOptions\(connections,/);
    assert.match(main, /runOnce\(input:\s*\{\s*mode:\s*DailyReviewMode;\s*modelKey\?:\s*string\s*\}\)/);
    assert.match(preload, /runOnce\(input:\s*\{\s*mode:\s*DailyReviewMode;\s*day\?:\s*number;\s*modelKey\?:\s*string\s*\}/);
    assert.match(mainProcess, /modelKeyOverride\?:\s*string/);
    assert.match(mainProcess, /resolveDailyReviewModelContext\(effectiveModelKey\)/);
  });
});
