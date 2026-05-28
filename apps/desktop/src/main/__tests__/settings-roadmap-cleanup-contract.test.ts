import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings coming-soon cleanup contract', () => {
  it('does not keep the old generic ComingSoon page registry or fallback renderer', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    assert.doesNotMatch(src, /type\s+ComingSoonCopy\b/, 'Settings must not keep a generic roadmap-page copy registry');
    assert.doesNotMatch(src, /COMING_SOON_PAGES/, 'Settings must not route sections through an empty coming-soon registry');
    assert.doesNotMatch(src, /function\s+ComingSoonPage\b/, 'Settings must not keep the generic unimplemented-page template');
    assert.doesNotMatch(src, /function\s+ComingSoonSection\b/, 'Settings must not keep generic coming-soon sections');
  });

  it('does not expose nav-level comingSoon state or command-palette soon hints', async () => {
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const palette = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    assert.doesNotMatch(settings, /comingSoon\??:/, 'Settings nav items must not carry stale comingSoon flags');
    assert.doesNotMatch(settings, /settingsNavBadge/, 'Settings nav must not render stale Roadmap badges');
    assert.doesNotMatch(palette, /即将推出/, 'Command palette settings entries must not advertise dead coming-soon hints');
    assert.doesNotMatch(palette, /comingSoon/, 'Command palette must not read removed nav comingSoon flags');
  });
});
