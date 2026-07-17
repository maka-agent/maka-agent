import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LocaleProvider,
  syncUiLocaleDocument,
  useUiLocale,
} from '../locale-context.js';

function LocaleProbe() {
  return <span>{useUiLocale()}</span>;
}

describe('LocaleProvider', () => {
  it('publishes an already-resolved locale through context', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <LocaleProbe />
      </LocaleProvider>,
    );

    assert.equal(markup, '<span>en</span>');
  });

  it('switches when the resolved locale changes', () => {
    const renderLocale = (locale: 'zh' | 'en') => renderToStaticMarkup(
      <LocaleProvider locale={locale}>
        <LocaleProbe />
      </LocaleProvider>,
    );

    assert.equal(renderLocale('zh'), '<span>zh</span>');
    assert.equal(renderLocale('en'), '<span>en</span>');
  });

  it('fails clearly when a reactive consumer is outside the provider', () => {
    assert.throws(
      () => renderToStaticMarkup(<LocaleProbe />),
      /useUiLocale must be used within LocaleProvider/,
    );
  });
});

describe('syncUiLocaleDocument', () => {
  it('synchronizes html lang, the resolved locale, and the test override', () => {
    const previousDocument = globalThis.document;
    const attributes = new Map<string, string>();
    globalThis.document = {
      documentElement: {
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
        removeAttribute(name: string) {
          attributes.delete(name);
        },
      },
    } as unknown as Document;

    try {
      syncUiLocaleDocument('zh', 'zh');
      assert.equal(attributes.get('lang'), 'zh');
      assert.equal(attributes.get('data-maka-locale'), 'zh');
      assert.equal(attributes.get('data-maka-visual-smoke-locale'), 'zh');

      syncUiLocaleDocument('en', null);
      assert.equal(attributes.get('lang'), 'en');
      assert.equal(attributes.get('data-maka-locale'), 'en');
      assert.equal(attributes.has('data-maka-visual-smoke-locale'), false);
    } finally {
      globalThis.document = previousDocument;
    }
  });

  it('is a no-op in non-DOM environments', () => {
    const previousDocument = globalThis.document;
    globalThis.document = undefined as unknown as Document;
    try {
      assert.doesNotThrow(() => syncUiLocaleDocument('en', null));
    } finally {
      globalThis.document = previousDocument;
    }
  });
});
