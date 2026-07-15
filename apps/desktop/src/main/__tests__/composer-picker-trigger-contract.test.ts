import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

test('composer permission and model pickers opt into quiet trigger chrome', async () => {
  const [composer, permissionMode, chatModelSwitcher, modelPicker] = await Promise.all([
    read('packages/ui/src/composer.tsx'),
    read('packages/ui/src/permission-mode-menu.tsx'),
    read('packages/ui/src/chat-model-switcher.tsx'),
    read('packages/ui/src/model-picker.tsx'),
  ]);

  assert.match(
    composer,
    /<PermissionModeSelect[\s\S]*?appearance="quiet"[\s\S]*?activeMode=/,
    'the composer permission picker must opt out of field chrome',
  );
  assert.match(
    permissionMode,
    /<SelectTrigger[\s\S]*?appearance=\{props\.appearance\}/,
    'PermissionModeSelect must forward its trigger appearance',
  );

  const composerModelPickers = chatModelSwitcher.match(/<ModelPicker[\s\S]*?>/g) ?? [];
  assert.equal(composerModelPickers.length, 2, 'both composer model picker variants must remain on the shared ModelPicker');
  for (const picker of composerModelPickers) {
    assert.match(picker, /triggerAppearance="quiet"/, 'each composer model picker must opt out of field chrome');
  }
  assert.match(
    modelPicker,
    /<ModelPickerTrigger[\s\S]*?appearance=\{props\.triggerAppearance\}/,
    'ModelPicker must forward its requested trigger appearance',
  );
});
