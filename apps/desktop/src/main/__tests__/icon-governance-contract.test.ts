/**
 * Icon + typography governance contract.
 *
 * The sidebar's competitor comparison surfaced three fault lines:
 *   1. Icon semantics were wrong (Sparkles for 技能 means nothing).
 *   2. Icons read as different families — call sites had accumulated a
 *      dozen different `strokeWidth` values, so the glyphs fragmented.
 *   3. The lucide funnel could drift if a call site imported lucide-react
 *      directly instead of through the @maka/ui/icons seam.
 *
 * This contract pins the outcome of the governance round:
 *   a) No `strokeWidth={...}` prop survives on lucide icon call sites under
 *      apps/desktop/src/renderer or packages/ui/src (brand-asset files
 *      excepted) — icons ride the single governed stroke instead.
 *   b) session-sidebar-nav.tsx imports exactly the decided semantic set
 *      (SquarePen / CalendarCheck / Blocks / Timer / Settings) from ./icons.js.
 *   c) icons.tsx stays the ONLY packages/ui/src file importing lucide-react
 *      (funnel integrity).
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const ICONS_FILE = resolve(REPO_ROOT, 'packages/ui/src/icons.tsx');
const SIDEBAR_NAV_FILE = resolve(REPO_ROOT, 'packages/ui/src/session-sidebar-nav.tsx');
const PROVIDER_BRAND_MARKS_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-brand-marks.tsx');
const PROVIDER_CATALOG_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-catalog.tsx');
const PROVIDERS_PANEL_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/ProvidersPanel.tsx');
const MINIMAX_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/minimax-logo-only-vertical-color-bg-white-text.svg',
);
const XAI_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/xai.svg');
const CEREBRAS_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/cerebras.svg');
const MISTRAL_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/mistral.svg');
const TOGETHER_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/together.svg');
const FIREWORKS_BRAND_MARK_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/fireworks.svg',
);
const NVIDIA_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/nvidia.svg');
const TENCENT_HUNYUAN_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/hunyuan.svg');
const TENCENT_CLOUD_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/tencentcloud.svg');
const STEPFUN_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/stepfun.svg');
const VOLCENGINE_BRAND_MARK_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/assets/provider-brands/volcengine.svg');
const DESKTOP_PACKAGE_FILE = resolve(REPO_ROOT, 'apps/desktop/package.json');
const THIRD_PARTY_NOTICES_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt');
const ONBOARDING_HERO_FILE = resolve(REPO_ROOT, 'apps/desktop/src/renderer/OnboardingHero.tsx');
const LM_STUDIO_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/lmstudio.svg',
);
const LOCALAI_BRAND_ASSET_FILE = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/assets/provider-brands/localai.svg',
);

// Fixed brand assets, not generic UI icons — their vendored SVGs keep
// their own stroke weight and are exempt from the call-site stroke sweep.
const STROKE_EXCEPTION_FILES = new Set([
  resolve(REPO_ROOT, 'packages/ui/src/bot-brand-logo.tsx'),
  resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-brand-marks.tsx'),
]);

async function walkTsx(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTsx(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');

describe('icon + typography governance contract', () => {
  it('rides lucide\'s single governed stroke — no per-call-site strokeWidth props', async () => {
    const dirs = [
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of await walkTsx(dir)) {
        if (STROKE_EXCEPTION_FILES.has(file)) continue;
        const src = await readFile(file, 'utf8');
        // The brace form is what lucide icon call sites use. Raw inline
        // <svg> primitives use the string form (strokeWidth="2") and are
        // not lucide glyphs, so they are outside this rule.
        if (/strokeWidth=\{/.test(src)) offenders.push(rel(file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'icons ride lucide\'s default stroke — per-callsite strokeWidth fragments the family. '
        + `Delete the strokeWidth={...} props in:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('session-sidebar-nav imports exactly the decided semantic icon set from ./icons.js', async () => {
    const src = await readFile(SIDEBAR_NAV_FILE, 'utf8');
    const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/icons\.js'/);
    assert.ok(importMatch, 'session-sidebar-nav.tsx must import its icons from ./icons.js');
    const imported = importMatch![1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    // Decided semantic mapping (maintainer 2026-07-10: 新任务 matches the
    // collapsed-topbar compose icon): 新任务 → SquarePen, 每日回顾 → CalendarCheck,
    // 技能 → Blocks, 定时任务 → Timer, 设置 → Settings.
    const expected = ['Blocks', 'CalendarCheck', 'Settings', 'SquarePen', 'Timer'];
    assert.deepEqual(
      imported,
      expected,
      `session-sidebar-nav.tsx must import exactly ${expected.join('/')} from ./icons.js (the semantic mapping)`,
    );
  });

  it('routes every packages/ui/src lucide import through the icons.tsx funnel', async () => {
    const files = await walkTsx(resolve(REPO_ROOT, 'packages/ui/src'));
    const offenders: string[] = [];
    for (const file of files) {
      if (file === ICONS_FILE) continue;
      const stripped = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/['"]lucide-react['"]/.test(stripped)) offenders.push(rel(file));
    }
    assert.deepEqual(
      offenders,
      [],
      'icons.tsx is the only lucide-react seam in packages/ui/src (funnel integrity). '
        + `Route these through @maka/ui/icons named exports:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('uses the vendored SiliconCloud brand mark for SiliconFlow', async () => {
    const src = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');

    assert.match(
      src,
      /function SiliconCloud\(\)[\s\S]*d="M22\.956 6\.521H12\.522c-\.577 0-1\.044\.468-1\.044 1\.044v3\.13/,
      'SiliconFlow must use the upstream @lobehub/icons-static-svg SiliconCloud path, not a hand-drawn placeholder',
    );
    assert.match(
      src,
      /case 'siliconflow':\s*return <SiliconCloud \/>/,
      'the SiliconFlow provider must resolve to its real brand mark',
    );
  });

  it('routes the MiniMax Coding Plan alias to the MiniMax brand mark', async () => {
    const src = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');

    assert.match(
      src,
      /case 'minimax-coding-plan':\s*case 'MiniMax':\s*case 'MiniMax-cn':\s*return <MiniMaxMark \/>/,
      'MiniMax Coding Plan must reuse the MiniMax brand mark instead of the generic placeholder',
    );
  });

  it('vendors the byte-exact official MiniMax brand-package SVG', async () => {
    const componentSrc = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');
    const asset = await readFile(MINIMAX_BRAND_ASSET_FILE);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '386033f6d1cfc5359877b402221a819f272cf6333eae12a95858fdcc226811a5',
      'MiniMax mark must remain byte-identical to the official brand-package member',
    );
    assert.match(componentSrc, /https:\/\/platform\.minimax\.io\/docs\/faq\/contact-us#brand-resources/);
    assert.match(componentSrc, /https:\/\/file\.cdn\.minimax\.io\/public\/MiniMax_Logo\.zip/);
    assert.match(
      componentSrc,
      /MiniMax_Logo\/svg\/logo-only\/vertical\/minimax_logo-only_vertical_color-bg_white-text\.svg/,
    );
    assert.match(
      componentSrc,
      /function MiniMaxMark\(\): ReactElement \{\s*return <img src=\{minimaxBrandMark\} alt="" \/>;\s*\}/,
      'MiniMax providers must render the vendored official file, never an inline hand-drawn path',
    );
  });

  it('uses the unmodified upstream xAI mark across catalog and provider detail surfaces', async () => {
    const [marks, catalog, providersPanel, xaiMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(PROVIDER_CATALOG_FILE, 'utf8'),
      readFile(PROVIDERS_PANEL_FILE, 'utf8'),
      readFile(XAI_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(xaiMark).digest('hex'),
      '89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451',
      'the vendored xAI mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 xai.svg',
    );
    assert.match(
      marks,
      /Real xAI\/Grok mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*32f4083f7a20b67ecdc7b29c0af031ada5a29c52[\s\S]*packages\/static-svg\/icons\/xai\.svg[\s\S]*license: MIT[\s\S]*function XAI\(\)[\s\S]*<ProviderAssetMask src=\{xaiMarkUrl\} \/>/,
      'xAI must render the traceable upstream SVG asset as a currentColor mask instead of a generic or hand-drawn mark',
    );
    assert.match(marks, /case 'xai':\s*return <XAI \/>/, 'the stable xai provider id must resolve to the upstream mark');
    assert.match(catalog, /<ProviderLogo type=\{props\.type\} \/>/, 'catalog cards must consume the shared provider logo seam');
    assert.match(
      providersPanel,
      /kind === 'detail' && selected[\s\S]*<ProviderPageHeader[\s\S]*providerType=\{selected\.providerType\}/,
      'saved connection detail must consume the shared provider logo seam',
    );
  });

  it('vendors and routes the byte-exact Lobe Icons Together AI SVG through the shared mask seam', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(TOGETHER_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      'b3ec218e7e0b0432a2ce07f5ec98a1dcd24f808c74d5fee624ab31e4947feef3',
      'Together AI SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0 together.svg',
    );
    assert.match(marks, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(marks, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(marks, /32f4083f7a20b67ecdc7b29c0af031ada5a29c52/);
    assert.match(marks, /packages\/static-svg\/icons\/together\.svg/);
    assert.match(marks, /license: MIT/);
    assert.match(marks, /b3ec218e7e0b0432a2ce07f5ec98a1dcd24f808c74d5fee624ab31e4947feef3/);
    assert.match(marks, /import togetherBrandMark from '\.\.\/assets\/provider-brands\/together\.svg';/);
    assert.match(marks, /case 'togetherai':\s*return <ProviderAssetMask src=\{togetherBrandMark\} \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/together\.svg[\s\S]*packages\/static-svg\/icons\/together\.svg[\s\S]*b3ec218e7e0b0432a2ce07f5ec98a1dcd24f808c74d5fee624ab31e4947feef3/,
    );
  });

  it('vendors and routes the byte-exact Fireworks SVG through the shared mask and notice seams', async () => {
    const [marks, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(FIREWORKS_BRAND_MARK_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '9991ab2a8331096d3f408e07a5f2e1cb54c369143dd9fc7a97f6458478b33fe3',
      'Fireworks SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0',
    );
    assert.match(
      marks,
      /Fireworks mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/fireworks\.svg[\s\S]*license: MIT[\s\S]*SHA-256: 9991ab2a8331096d3f408e07a5f2e1cb54c369143dd9fc7a97f6458478b33fe3/,
    );
    assert.match(marks, /import fireworksMarkUrl from '\.\.\/assets\/provider-brands\/fireworks\.svg';/);
    assert.match(marks, /case 'fireworks-ai':\s*return <ProviderAssetMask src=\{fireworksMarkUrl\} \/>/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/fireworks\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/fireworks\.svg[\s\S]*9991ab2a8331096d3f408e07a5f2e1cb54c369143dd9fc7a97f6458478b33fe3/,
    );
  });

  it('keeps the verified Ollama mark and routes it through catalog, detail, and first-run surfaces', async () => {
    const [marks, catalog, providersPanel, onboardingHero, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(PROVIDER_CATALOG_FILE, 'utf8'),
      readFile(PROVIDERS_PANEL_FILE, 'utf8'),
      readFile(ONBOARDING_HERO_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.match(
      marks,
      /Vendored unchanged from @lobehub\/icons-static-svg@1\.91\.0:[\s\S]*github\.com\/lobehub\/lobe-icons\/blob\/32f4083f7a20b67ecdc7b29c0af031ada5a29c52\/packages\/static-svg\/icons\/ollama\.svg[\s\S]*MIT license/,
      'the Ollama mark must record its repository, package version, commit, file path, license, and unchanged-vendor status',
    );
    const ollamaPath = marks.match(/function Ollama\(\)[\s\S]*?<path d="([^"]+)" \/>/)?.[1];
    assert.ok(ollamaPath, 'the Ollama provider must render its vendored SVG path');
    assert.equal(
      createHash('sha256').update(ollamaPath).digest('hex'),
      'fe847dff4bb6ae25ebec9a7def819ec2583023552b2e88a572c481aad2d32433',
      'the complete Ollama path must remain byte-identical to the pinned Lobe Icons SVG',
    );
    assert.ok(
      notices.includes(
        '`apps/desktop/src/renderer/settings/provider-brand-marks.tsx` `Ollama` path\n' +
          '    - Upstream commit: `32f4083f7a20b67ecdc7b29c0af031ada5a29c52`\n' +
          '    - Upstream path: `packages/static-svg/icons/ollama.svg`\n' +
          '    - SHA-256: `fe847dff4bb6ae25ebec9a7def819ec2583023552b2e88a572c481aad2d32433`',
      ),
      'the shared Lobe Icons notice must inventory the vendored Ollama asset',
    );
    assert.match(marks, /case 'ollama':\s*return <Ollama \/>/);
    assert.match(catalog, /<ProviderLogo type=\{props\.type\} \/>/);
    assert.match(
      providersPanel,
      /providerType=\{selected\.providerType\}[\s\S]*function ProviderPageHeader[\s\S]*<ProviderLogo type=\{props\.providerType\} compact \/>/,
      'the connection detail header must render the same provider mark as the catalog',
    );
    assert.match(onboardingHero, /<ProviderLogo type=\{type\} compact \/>/);
  });

  it('vendors the unmodified upstream Cerebras mark with traceable provenance', async () => {
    const [marks, notices, cerebrasMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
      readFile(CEREBRAS_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(cerebrasMark).digest('hex'),
      '05af9593eca3fefdb30c5ad042040f008beea2b27e0a6b7315c319492f7a44ff',
      'the vendored Cerebras mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 cerebras.svg',
    );
    assert.match(
      notices,
      /Repository: https:\/\/github\.com\/lobehub\/lobe-icons[\s\S]*@lobehub\/icons-static-svg` version `1\.91\.0`[\s\S]*apps\/desktop\/src\/renderer\/assets\/provider-brands\/cerebras\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/cerebras\.svg[\s\S]*05af9593eca3fefdb30c5ad042040f008beea2b27e0a6b7315c319492f7a44ff/,
      'Cerebras provenance must identify the exact package release, upstream revision, path, and license',
    );
    assert.match(
      marks,
      /import cerebrasMarkUrl from '\.\.\/assets\/provider-brands\/cerebras\.svg';[\s\S]*case 'cerebras':\s*return <ProviderAssetMask src=\{cerebrasMarkUrl\} \/>/,
      'the stable Cerebras provider id must consume the sole shared asset-mask seam',
    );
    assert.doesNotMatch(marks, /ProviderMaskMark|providerMaskMark/);
  });

  it('vendors and routes the byte-exact upstream Mistral mark through the shared asset-mask seam', async () => {
    const [mistralMark, componentSrc, notices] = await Promise.all([
      readFile(MISTRAL_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(mistralMark).digest('hex'),
      'a06cfa54e7deff7f7544175b006b7f8a03fbc5624c44f7d553a44d07ea96e629',
      'the vendored Mistral mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 mistral.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/mistral\.svg[\s\S]*32f4083f7a20b67ecdc7b29c0af031ada5a29c52[\s\S]*packages\/static-svg\/icons\/mistral\.svg[\s\S]*a06cfa54e7deff7f7544175b006b7f8a03fbc5624c44f7d553a44d07ea96e629/,
      'Mistral must append provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import mistralBrandMark from '\.\.\/assets\/provider-brands\/mistral\.svg';/);
    assert.match(
      componentSrc,
      /Mistral mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*32f4083f7a20b67ecdc7b29c0af031ada5a29c52[\s\S]*packages\/static-svg\/icons\/mistral\.svg[\s\S]*MIT[\s\S]*a06cfa54e7deff7f7544175b006b7f8a03fbc5624c44f7d553a44d07ea96e629/,
    );
    assert.match(componentSrc, /case 'mistral':\s*return <ProviderAssetMask src=\{mistralBrandMark\} \/>/);
  });

  it('vendors the unmodified upstream NVIDIA mark with traceable provenance', async () => {
    const [marks, notices, nvidiaMark] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
      readFile(NVIDIA_BRAND_MARK_FILE),
    ]);

    assert.equal(
      createHash('sha256').update(nvidiaMark).digest('hex'),
      '5a419b99e0ffdbfbe8caa7ec25581054eae03024da59cb860c54ea55ac8e7e73',
      'the vendored NVIDIA mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 nvidia.svg',
    );
    assert.match(
      notices,
      /Repository: https:\/\/github\.com\/lobehub\/lobe-icons[\s\S]*@lobehub\/icons-static-svg` version `1\.91\.0`[\s\S]*apps\/desktop\/src\/renderer\/assets\/provider-brands\/nvidia\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/nvidia\.svg[\s\S]*5a419b99e0ffdbfbe8caa7ec25581054eae03024da59cb860c54ea55ac8e7e73/,
      'NVIDIA provenance must identify the exact package release, upstream revision, path, and license',
    );
    assert.match(
      marks,
      /import nvidiaMarkUrl from '\.\.\/assets\/provider-brands\/nvidia\.svg';[\s\S]*case 'nvidia':\s*return <ProviderAssetMask src=\{nvidiaMarkUrl\} \/>/,
      'the stable NVIDIA provider id must consume the sole shared asset-mask seam',
    );
    assert.doesNotMatch(marks, /NvidiaMask|nvidiaAssetMask/);
  });

  it('vendors and routes the byte-exact upstream Hunyuan mark through the shared asset-mask seam', async () => {
    const [hunyuanMark, componentSrc, notices] = await Promise.all([
      readFile(TENCENT_HUNYUAN_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(hunyuanMark).digest('hex'),
      '7306a65eb71c4de61e21a637e5c4fef94afde823678e225c46f891cc783f6531',
      'the vendored Hunyuan mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 hunyuan.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/hunyuan\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/hunyuan\.svg[\s\S]*7306a65eb71c4de61e21a637e5c4fef94afde823678e225c46f891cc783f6531/,
      'Tencent must append byte-exact Hunyuan provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import hunyuanBrandMark from '\.\.\/assets\/provider-brands\/hunyuan\.svg';/);
    assert.match(
      componentSrc,
      /Hunyuan mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/hunyuan\.svg[\s\S]*MIT[\s\S]*7306a65eb71c4de61e21a637e5c4fef94afde823678e225c46f891cc783f6531/,
    );
    assert.match(componentSrc, /case 'tencent-tokenhub':\s*return <ProviderAssetMask src=\{hunyuanBrandMark\} \/>/);
  });

  it('vendors and routes the byte-exact upstream StepFun mark through the shared asset-mask seam', async () => {
    const [stepfunMark, componentSrc, notices] = await Promise.all([
      readFile(STEPFUN_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(stepfunMark).digest('hex'),
      'f46fbd1eee00a3dc7874395484bcc3e25a803e9eb4b79f07b7eec377a1e2f25c',
      'the vendored StepFun mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 stepfun.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/stepfun\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/stepfun\.svg[\s\S]*f46fbd1eee00a3dc7874395484bcc3e25a803e9eb4b79f07b7eec377a1e2f25c/,
      'StepFun must append byte-exact provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import stepfunBrandMark from '\.\.\/assets\/provider-brands\/stepfun\.svg';/);
    assert.match(
      componentSrc,
      /StepFun mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/stepfun\.svg[\s\S]*MIT[\s\S]*f46fbd1eee00a3dc7874395484bcc3e25a803e9eb4b79f07b7eec377a1e2f25c/,
    );
    assert.match(componentSrc, /case 'stepfun':\s*return <ProviderAssetMask src=\{stepfunBrandMark\} \/>/);
    assert.match(
      componentSrc,
      /case 'stepfun-step-plan':\s*case 'stepfun-ai':\s*case 'stepfun':\s*return <ProviderAssetMask src=\{stepfunBrandMark\} \/>/,
      'catalog and detail must route every StepFun access path through the same shared mark and mask seam',
    );
  });

  it('vendors and routes the byte-exact upstream Volcengine mark through the shared asset-mask seam', async () => {
    const [volcengineMark, componentSrc, notices] = await Promise.all([
      readFile(VOLCENGINE_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(volcengineMark).digest('hex'),
      'f29d0bdc284b33d8664ef221add7fbf06a5b370ef92767fa33f6020c914d3d33',
      'the vendored Volcengine mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 volcengine.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/volcengine\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/volcengine\.svg[\s\S]*f29d0bdc284b33d8664ef221add7fbf06a5b370ef92767fa33f6020c914d3d33/,
      'Volcengine must append byte-exact provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import volcengineBrandMark from '\.\.\/assets\/provider-brands\/volcengine\.svg';/);
    assert.match(
      componentSrc,
      /Volcengine mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/volcengine\.svg[\s\S]*MIT[\s\S]*f29d0bdc284b33d8664ef221add7fbf06a5b370ef92767fa33f6020c914d3d33/,
    );
    assert.match(
      componentSrc,
      /case 'volcengine-ark':\s*case 'volcengine-coding-plan':\s*return <ProviderAssetMask src=\{volcengineBrandMark\} \/>/,
      'direct Ark and Coding Plan must share the single governed Volcengine asset route',
    );
  });

  it('routes Tencent plans through the shared byte-exact Tencent Cloud mark', async () => {
    const [tencentCloudMark, componentSrc, notices] = await Promise.all([
      readFile(TENCENT_CLOUD_BRAND_MARK_FILE),
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(tencentCloudMark).digest('hex'),
      '0563b1dbaa01aff4f20352bc9eb49bec17debeb3901a9ee80b044ac4d792c97d',
      'the vendored Tencent Cloud mark must remain byte-identical to @lobehub/icons-static-svg@1.91.0 tencentcloud.svg',
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/tencentcloud\.svg[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/tencentcloud\.svg[\s\S]*0563b1dbaa01aff4f20352bc9eb49bec17debeb3901a9ee80b044ac4d792c97d/,
      'Tencent Coding Plan must append byte-exact Tencent Cloud provenance to the existing Lobe Icons notice entry',
    );
    assert.match(componentSrc, /import tencentCloudBrandMark from '\.\.\/assets\/provider-brands\/tencentcloud\.svg';/);
    assert.match(
      componentSrc,
      /Tencent Cloud mark vendored byte-for-byte from Lobe Icons:[\s\S]*@lobehub\/icons-static-svg@1\.91\.0[\s\S]*e4302041fbb3039608d25f9f618bd462783b875e[\s\S]*packages\/static-svg\/icons\/tencentcloud\.svg[\s\S]*MIT[\s\S]*0563b1dbaa01aff4f20352bc9eb49bec17debeb3901a9ee80b044ac4d792c97d/,
    );
    assert.match(
      componentSrc,
      /case 'tencent-coding-plan':\s*case 'tencent-token-plan':\s*return <ProviderAssetMask src=\{tencentCloudBrandMark\} \/>/,
    );
  });

  it('ships the Lobe Icons MIT notice beside vendored provider assets', async () => {
    const [desktopPackage, notices] = await Promise.all([
      readFile(DESKTOP_PACKAGE_FILE, 'utf8'),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.match(notices, /## Lobe Icons/);
    assert.match(notices, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(notices, /@lobehub\/icons-static-svg` version `1\.91\.0`/);
    assert.match(notices, /32f4083f7a20b67ecdc7b29c0af031ada5a29c52/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/xai\.svg[\s\S]*packages\/static-svg\/icons\/xai\.svg[\s\S]*89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451/,
    );
    assert.match(notices, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/lmstudio\.svg[\s\S]*packages\/static-svg\/icons\/lmstudio\.svg[\s\S]*4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b/,
    );
    assert.match(
      notices,
      /apps\/desktop\/src\/renderer\/assets\/provider-brands\/cerebras\.svg[\s\S]*packages\/static-svg\/icons\/cerebras\.svg[\s\S]*05af9593eca3fefdb30c5ad042040f008beea2b27e0a6b7315c319492f7a44ff/,
    );
    assert.match(notices, /MIT License[\s\S]*Copyright \(c\) 2023 LobeHub[\s\S]*Permission is hereby granted/);
    assert.match(notices, /THE SOFTWARE IS PROVIDED "AS IS"/);
    assert.match(
      desktopPackage,
      /"build:renderer": "vite build && node \.\.\/\.\.\/scripts\/check-third-party-notices\.mjs"/,
      'renderer builds must verify that the public notice was copied byte-for-byte into dist-renderer',
    );
  });

  it('vendors and renders the byte-exact Lobe Icons LM Studio SVG', async () => {
    const componentSrc = await readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8');
    const asset = await readFile(LM_STUDIO_BRAND_ASSET_FILE);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b',
      'LM Studio SVG must remain byte-identical to @lobehub/icons-static-svg@1.91.0',
    );
    assert.match(componentSrc, /https:\/\/github\.com\/lobehub\/lobe-icons/);
    assert.match(componentSrc, /@lobehub\/icons-static-svg@1\.91\.0/);
    assert.match(componentSrc, /e4302041fbb3039608d25f9f618bd462783b875e/);
    assert.match(componentSrc, /packages\/static-svg\/icons\/lmstudio\.svg/);
    assert.match(componentSrc, /MIT/);
    assert.match(componentSrc, /4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b/);
    assert.match(componentSrc, /import lmStudioBrandMark from '\.\.\/assets\/provider-brands\/lmstudio\.svg';/);
    assert.match(componentSrc, /function ProviderAssetMask\([\s\S]*className="providerAssetMask"[\s\S]*WebkitMaskImage: mask/);
    assert.match(componentSrc, /case 'lm-studio':\s*return <ProviderAssetMask src=\{lmStudioBrandMark\} \/>/);
  });

  it('vendors and renders the byte-exact official LocalAI SVG', async () => {
    const [componentSrc, asset, notices] = await Promise.all([
      readFile(PROVIDER_BRAND_MARKS_FILE, 'utf8'),
      readFile(LOCALAI_BRAND_ASSET_FILE),
      readFile(THIRD_PARTY_NOTICES_FILE, 'utf8'),
    ]);

    assert.equal(
      createHash('sha256').update(asset).digest('hex'),
      '1349c022f30a58836e9b09591031f25bf4ff6bb8627bb50691a46a1c8a512c39',
      'LocalAI SVG must remain byte-identical to the official LocalAI repository',
    );
    assert.match(componentSrc, /import localAiBrandMark from '\.\.\/assets\/provider-brands\/localai\.svg';/);
    assert.match(componentSrc, /case 'localai':\s*return <ProviderAssetMask src=\{localAiBrandMark\} \/>/);
    assert.match(
      notices,
      /## LocalAI[\s\S]*mudler\/LocalAI[\s\S]*MIT[\s\S]*b10e330590766ea621c0b03401e77a0589558e76[\s\S]*docs\/assets\/images\/logos\/logo\.svg[\s\S]*1349c022f30a58836e9b09591031f25bf4ff6bb8627bb50691a46a1c8a512c39/,
    );
  });
});
