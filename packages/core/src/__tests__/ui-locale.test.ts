import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  UI_LOCALES,
  UI_LOCALE_PREFERENCES,
  isUiLocale,
  isUiLocalePreference,
  resolveUiLocale,
  uiLocaleToIntlLocale,
  type UiCatalog,
} from '../index.js';

// @ts-expect-error Every catalog must include English; no implicit fallback.
const missingEnglishCatalog: UiCatalog<string> = { zh: '中文' };
void missingEnglishCatalog;

describe('UI locale contract', () => {
  it('exposes the complete supported locale and preference sets', () => {
    assert.deepEqual([...UI_LOCALES], ['zh', 'en']);
    assert.deepEqual([...UI_LOCALE_PREFERENCES], ['auto', 'zh', 'en']);
  });

  it('accepts only supported resolved locales', () => {
    assert.equal(isUiLocale('zh'), true);
    assert.equal(isUiLocale('en'), true);
    assert.equal(isUiLocale('auto'), false);
    assert.equal(isUiLocale('ja'), false);
    assert.equal(isUiLocale(null), false);
  });

  it('accepts only supported persisted preferences', () => {
    assert.equal(isUiLocalePreference('auto'), true);
    assert.equal(isUiLocalePreference('zh'), true);
    assert.equal(isUiLocalePreference('en'), true);
    assert.equal(isUiLocalePreference('ja'), false);
    assert.equal(isUiLocalePreference(undefined), false);
  });

  it('temporarily resolves auto to Chinese', () => {
    assert.equal(resolveUiLocale('auto'), 'zh');
  });

  it('preserves an explicit supported preference', () => {
    assert.equal(resolveUiLocale('zh'), 'zh');
    assert.equal(resolveUiLocale('en'), 'en');
  });

  it('gives a test override precedence over every persisted preference', () => {
    assert.equal(resolveUiLocale('auto', 'en'), 'en');
    assert.equal(resolveUiLocale('en', 'zh'), 'zh');
    assert.equal(resolveUiLocale('zh', null), 'zh');
  });

  it('maps the resolved locale to the Intl locale used by formatters', () => {
    assert.equal(uiLocaleToIntlLocale('zh'), 'zh-CN');
    assert.equal(uiLocaleToIntlLocale('en'), 'en');
  });

  it('provides a compile-time complete catalog shape', () => {
    const catalog = {
      zh: { label: '中文' },
      en: { label: 'English' },
    } satisfies UiCatalog<{ label: string }>;

    assert.deepEqual(Object.keys(catalog), ['zh', 'en']);
  });
});
