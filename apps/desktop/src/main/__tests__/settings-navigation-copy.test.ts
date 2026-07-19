import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SETTINGS_SECTIONS } from '@maka/core';
import { getSettingsNavigationCopy } from '../../renderer/locales/settings-navigation-copy.js';
import { getSettingsSharedCopy } from '../../renderer/locales/settings-shared-copy.js';
import { groupedNav, navLabel } from '../../renderer/settings/settings-nav.js';

describe('Settings navigation copy', () => {
  it('covers every SettingsSection in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = getSettingsNavigationCopy(locale);
      assert.deepEqual(Object.keys(copy.sections).sort(), [...SETTINGS_SECTIONS].sort());
      for (const section of SETTINGS_SECTIONS) {
        assert.ok(copy.sections[section].label.length > 0);
        assert.ok(copy.sections[section].description.length > 0);
      }
    }
  });

  it('renders stable metadata with locale-specific labels', () => {
    assert.equal(navLabel('general', 'zh'), '通用');
    assert.equal(navLabel('general', 'en'), 'General');
    assert.equal(groupedNav('en')[0]?.label, 'General');
    assert.equal(groupedNav('en')[1]?.label, 'AI & Integrations');
    assert.equal(groupedNav('en')[2]?.label, 'System');
    assert.equal(groupedNav('en').flatMap((group) => group.items).find((item) => item.id === 'search')?.badge, 'Beta');
  });

  it('provides complete shared frame and failure copy without fallback', () => {
    assert.equal(getSettingsSharedCopy('zh').modalLabel, '设置');
    assert.equal(getSettingsSharedCopy('en').modalLabel, 'Settings');
    assert.equal(getSettingsSharedCopy('en').backToApp, 'Back to app');
    assert.equal(getSettingsSharedCopy('en').loading, 'Loading settings');
    assert.equal(getSettingsSharedCopy('en').unknownError, 'Something went wrong. Try again.');
  });
});
