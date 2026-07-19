import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

describe('Settings preference copy', () => {
  it('covers persisted theme, palette, and locale values in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = getSettingsPreferencesCopy(locale);
      assert.deepEqual(Object.keys(copy.appearance.themeOptions).sort(), ['auto', 'dark', 'light']);
      assert.deepEqual(Object.keys(copy.appearance.paletteLabels).sort(), [
        'azure', 'catppuccin-mocha', 'coral', 'default', 'dusk', 'forest', 'mono', 'nord', 'onedark', 'sand', 'tokyo-night',
      ]);
      assert.deepEqual(copy.personalization.localeOptions.map(([value]) => value), ['auto', 'zh', 'en']);
    }
    assert.equal(getSettingsPreferencesCopy('en').personalization.localeOptions[0]?.[1], 'Follow system');
  });

  it('keeps English preference pages free of silent Chinese fallback', () => {
    const copy = getSettingsPreferencesCopy('en');
    assert.equal(copy.password.show, 'Show');
    assert.equal(copy.about.copyEnvironment, 'Copy environment info');
    assert.equal(copy.general.defaultModel, 'Default model');
    const { localeOptions: _languageEndonyms, ...personalization } = copy.personalization;
    assert.doesNotMatch(JSON.stringify({ ...copy, personalization }), /[\u3400-\u9fff]/u);
  });
});
