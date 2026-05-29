/**
 * PR-WEB-SEARCH-TAVILY-0 — static-analysis gate that the renderer
 * never imports the Tavily client and never declares a cleartext
 * `apiKey` field on the `web-search` boundary.
 *
 * The cleartext Tavily key only ever lives in the main process. The
 * renderer can read a masked sentinel from settings and submit a new
 * draft string to overwrite it, but it must NEVER pull the cleartext
 * value back through any IPC channel.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

const RENDERER_FILES = [
  'apps/desktop/src/renderer/main.tsx',
  'apps/desktop/src/renderer/settings/SettingsModal.tsx',
  'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
  'apps/desktop/src/preload/preload.ts',
];

describe('web-search renderer boundary (PR-WEB-SEARCH-TAVILY-0)', () => {
  it('unsupported provider copy describes the current configuration, not a roadmap gap', async () => {
    const main = await readFile(join(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
    const unsupportedBlock = main.match(/const unsupportedWebSearchProviderResponse[\s\S]*?;\n\s*ipcMain\.handle/);

    assert.ok(unsupportedBlock, 'main process must centralize unsupported-provider copy');
    assert.match(unsupportedBlock![0], /reason:\s*'unsupported_provider'/);
    assert.match(unsupportedBlock![0], /当前配置不支持这个搜索引擎，请选择 Tavily 后重试。/);
    assert.doesNotMatch(
      unsupportedBlock![0],
      /暂未|尚未|即将|coming soon|todo|roadmap/i,
      'unsupported provider copy must not read like unfinished roadmap work',
    );
    assert.equal(
      (main.match(/unsupportedWebSearchProviderResponse/g) ?? []).length,
      3,
      'query/test handlers must reuse the same product copy instead of drifting',
    );
  });

  it('renderer never imports the main-process Tavily client', async () => {
    for (const rel of RENDERER_FILES) {
      const src = await readFile(join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(
        src,
        /from\s+['"][^'"]*tavily['"]/,
        `${rel} must not import tavily — main-process only`,
      );
      assert.doesNotMatch(
        src,
        /from\s+['"][^'"]*web-search\/[^'"]+['"]/,
        `${rel} must not pull from apps/desktop main/web-search/* path`,
      );
    }
  });

  it('preload + global type declarations do not surface a cleartext WebSearch apiKey field on responses', async () => {
    // The settings shape may carry `apiKey` (the masked sentinel is
    // routed there). The query/test responses must not.
    const preload = await readFile(join(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    assert.doesNotMatch(
      preload,
      /webSearch:[\s\S]*?apiKey:\s*string;[^{]*?\):/,
      'preload webSearch bridge must not declare an outgoing apiKey on its return types',
    );
    // The response type is `WebSearchResponse` from @maka/core which
    // is a discriminated union of `{results}` / `{reason, message}`.
    // Neither variant carries an `apiKey` field; this assertion is
    // belt-and-braces.
    const coreShape = await readFile(join(REPO_ROOT, 'packages/core/src/web-search.ts'), 'utf8');
    const responseBlock = coreShape.match(/export type WebSearchResponse[\s\S]*?;/);
    assert.ok(responseBlock, 'WebSearchResponse type block must exist');
    assert.doesNotMatch(
      responseBlock![0],
      /apiKey/,
      'WebSearchResponse must NOT carry apiKey in either variant',
    );
  });

  it('Settings persists credential test results with the observed key version', async () => {
    const settings = await readFile(join(REPO_ROOT, 'apps/desktop/src/renderer/settings/SettingsModal.tsx'), 'utf8');
    assert.match(
      settings,
      /const testedCredentialVersion = tavily\.credentialVersion/,
      'credential test must snapshot the saved key version before awaiting network',
    );
    assert.match(
      settings,
      /persistCredentialStatus\(webSearchCredentialStatusFromResponse\(result\), testedCredentialVersion\)/,
      'credential test result must carry the observed key version back to settings',
    );
    assert.match(
      settings,
      /const queriedCredentialVersion = tavily\.credentialVersion/,
      'live query must snapshot the saved key version before awaiting network',
    );
    assert.match(
      settings,
      /persistCredentialStatus\('valid', queriedCredentialVersion\)/,
      'successful live query status must carry the observed key version',
    );
  });

  it('Settings live query button explains the actionable disabled reason', async () => {
    const settings = await readFile(join(REPO_ROOT, 'apps/desktop/src/renderer/settings/SettingsModal.tsx'), 'utf8');
    const helper = settings.match(/function webSearchQueryDisabledReason[\s\S]*?function presentWebSearchCredentialStatus/);

    assert.ok(helper, 'Web search settings must have a dedicated disabled-reason helper');
    assert.match(helper![0], /先保存 Tavily API key/);
    assert.match(helper![0], /先启用联网搜索/);
    assert.match(helper![0], /输入查询后再搜索/);
    assert.match(settings, /disabled=\{liveQueryRunning \|\| queryDisabledReason !== null\}/);
    assert.match(settings, /\{queryDisabledReason\}/);
    assert.doesNotMatch(
      settings,
      /先开关启用联网搜索/,
      'Web search disabled copy must not tell users to enable a switch that may itself be blocked by a missing key',
    );
  });

  it('Settings live query copy uses product language instead of demo/debug wording', async () => {
    const settings = await readFile(join(REPO_ROOT, 'apps/desktop/src/renderer/settings/SettingsModal.tsx'), 'utf8');
    const page = settings.match(/function WebSearchSettingsPage[\s\S]*?function webSearchQueryDisabledReason/);

    assert.ok(page, 'Web search settings page block must exist');
    assert.match(page![0], /真实查询验证/);
    assert.match(page![0], /不写入会话也不写入遥测/);
    assert.match(page![0], /Electron safeStorage 最佳实践/);
    assert.doesNotMatch(page![0], />试一下</);
    assert.doesNotMatch(page![0], />试一下<|不入 telemetry|demoQuery|demoRunning|runDemo|demoResults|demoError|试一下" demo/);
  });

  it('WebSearch shared tool-result source uses live-query naming instead of demo language', async () => {
    const ui = await readFile(join(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const coreEvents = await readFile(join(REPO_ROOT, 'packages/core/src/events.ts'), 'utf8');
    const webSearchPreview = ui.match(/function WebSearchPreview[\s\S]*?function FileDiffPreview/);
    const webSearchContent = coreEvents.match(/PR-CHAT-WEB-SEARCH-RENDER-0[\s\S]*?kind:\s*'web_search'/);

    assert.ok(webSearchPreview, 'WebSearchPreview block must exist');
    assert.ok(webSearchContent, 'web_search ToolResultContent block must exist');
    assert.match(ui, /live-query[\s\S]*verification/);
    assert.match(coreEvents, /live-query[\s\S]*verification/);
    assert.doesNotMatch(webSearchPreview![0], /试一下|demo|manual try-out/i);
    assert.doesNotMatch(webSearchContent![0], /试一下|demo|manual try-out/i);
  });
});
