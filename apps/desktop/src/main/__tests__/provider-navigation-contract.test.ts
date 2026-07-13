import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const PANEL = resolve(import.meta.dirname, '../../../src/renderer/settings/ProvidersPanel.tsx');
const PROVIDER_CSS = resolve(import.meta.dirname, '../../../src/renderer/styles/settings/provider-editor.css');

describe('Settings model provider page hierarchy', () => {
  test('uses in-pane catalog, add, and detail pages instead of a config Sheet', async () => {
    const source = await readFile(PANEL, 'utf8');

    assert.match(source, /type ProviderPage\s*=/, 'ProvidersPanel must own an explicit child-page state');
    assert.match(source, /kind:\s*'catalog'/, 'the provider catalog must be an independent child page');
    assert.match(source, /kind:\s*'add'/, 'provider configuration must be an independent child page');
    assert.match(source, /kind:\s*'detail'/, 'connection detail must be an independent child page');
    assert.match(source, /aria-label="返回模型连接"/, 'child pages must expose a keyboard-accessible back action');
    assert.doesNotMatch(source, /ProviderConfigSheetOverlay/, 'provider configuration must not remain in a right Sheet');
  });

  test('catalog supports search and the five user-intent categories', async () => {
    const source = await readFile(PANEL, 'utf8');

    assert.match(source, /placeholder="搜索服务商"/);
    for (const category of ['recommended', 'plans', 'api', 'aggregators', 'local']) {
      assert.match(source, new RegExp(`id:\\s*'${category}'`), `missing catalog category ${category}`);
    }
  });

  test('catalog is a reversible child pane with standard search chrome below its category tabs', async () => {
    const [source, css] = await Promise.all([
      readFile(PANEL, 'utf8'),
      readFile(PROVIDER_CSS, 'utf8'),
    ]);

    assert.match(
      source,
      /if \(page\.kind === 'catalog'\)[\s\S]*<ProviderPageHeader[\s\S]*title="添加服务商"[\s\S]*onBack=\{\(\) => navigate\(\{ kind: 'connections' \}, \{ kind: 'add-provider' \}\)\}/,
      'the catalog must provide a way back to model connections',
    );
    assert.match(
      source,
      /<PrimitiveTabsList[\s\S]*<InputGroup className="providerCatalogSearch">[\s\S]*<InputGroupAddon>[\s\S]*<Search[\s\S]*<InputGroupInput/,
      'category scope must precede a standard grouped search field',
    );
    assert.match(
      css,
      /\.providerCatalogSearch\s*\{[^}]*width:\s*min\(100%, 360px\);[^}]*min-height:\s*var\(--h-control-lg\);/,
      'catalog search must stay compact without collapsing below the standard control height',
    );
  });
});
