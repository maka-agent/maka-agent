import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type ProviderPanelSharedModule = {
  nextSlug(type: string, existing: string[]): string;
};

// dynamic import: provider-panel-shared lives under src/renderer, which is
// outside tsconfig.main.json's include scope, so main-process tests cannot
// import it statically — esbuild bundles it to a temp module first.
async function importProviderPanelShared(): Promise<ProviderPanelSharedModule> {
  const outdir = await mkdtemp(resolve(tmpdir(), 'maka-provider-panel-shared-'));
  const outfile = resolve(outdir, 'provider-panel-shared.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-panel-shared.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as ProviderPanelSharedModule;
}

describe('nextSlug', () => {
  it('derives a validateSlug-compatible slug from a providerType with uppercase letters', async () => {
    const { nextSlug } = await importProviderPanelShared();
    const slugRe = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

    assert.equal(nextSlug('MiniMax', []), 'minimax');
    assert.equal(nextSlug('MiniMax-cn', []), 'minimax-cn');

    for (const type of ['MiniMax', 'MiniMax-cn', 'zai-coding-plan', 'cloudflare-workers-ai']) {
      const slug = nextSlug(type, []);
      assert.ok(slugRe.test(slug), `slug "${slug}" for providerType "${type}" must satisfy validateSlug`);
    }
  });

  it('appends a numeric suffix when the base slug is already taken', async () => {
    const { nextSlug } = await importProviderPanelShared();
    assert.equal(nextSlug('MiniMax', ['minimax']), 'minimax-2');
    assert.equal(nextSlug('MiniMax-cn', ['minimax-cn', 'minimax-cn-2']), 'minimax-cn-3');
  });
});
