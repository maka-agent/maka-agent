/**
 * PR-BUILD-HYGIENE-0 contract: the repo-root hygiene scripts and
 * `npm run clean` / `check:stale` entries must exist so future PRs
 * can't silently delete the foot-gun guard.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

describe('build-hygiene contract (PR-BUILD-HYGIENE-0)', () => {
  it('root package.json exposes clean / rebuild / check:stale scripts', () => {
    const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    assert.ok(scripts.clean, 'root package.json must define `clean`');
    assert.ok(scripts.rebuild, 'root package.json must define `rebuild`');
    assert.ok(scripts['check:stale'], 'root package.json must define `check:stale`');
    assert.ok(scripts['check:release'], 'root package.json must define `check:release`');
    assert.match(scripts.clean!, /clean-build\.mjs/);
    assert.match(scripts['check:stale']!, /check-stale-dist\.mjs/);
    assert.match(
      scripts['check:release']!,
      /check:stale/,
      '`check:release` must continue to gate on stale build output checks.',
    );
    assert.match(
      scripts['check:release']!,
      /check:officecli-bundle/,
      '`check:release` must continue to gate on OfficeCLI bundle integrity.',
    );
    assert.match(
      scripts['check:release']!,
      /check:cua-driver-bundle/,
      '`check:release` must continue to gate on cua-driver bundle integrity.',
    );
    assert.match(
      scripts['check:release']!,
      /check-dead-css\.mjs --check/,
      '`check:release` must continue to gate on the Round G dead-CSS baseline check.',
    );
  });

  it('build hygiene scripts exist under scripts/', () => {
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'clean-build.mjs')),
      'scripts/clean-build.mjs must exist',
    );
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'check-stale-dist.mjs')),
      'scripts/check-stale-dist.mjs must exist',
    );
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'check-dead-css.mjs')),
      'scripts/check-dead-css.mjs must exist',
    );
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'check-dead-css-baseline.json')),
      'scripts/check-dead-css-baseline.json must exist',
    );
  });

  it('pins cua-driver archive and extracted-binary checksums separately', () => {
    const manifestRaw = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'bundled-tools.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      cuaDriver?: {
        archiveSha256?: string;
        binarySha256?: string;
        sha256?: string;
      };
    };
    const prepare = readFileSync(join(REPO_ROOT, 'scripts', 'prepare-cua-driver.mjs'), 'utf8');
    const check = readFileSync(join(REPO_ROOT, 'scripts', 'check-cua-driver-bundle.mjs'), 'utf8');
    const cua = manifest.cuaDriver;
    const prepareEntry = prepare.match(
      /export async function prepareCuaDriver[\s\S]*?const url = cuaDriverDownloadUrl/,
    );

    assert.ok(cua, 'bundled-tools.json must define cuaDriver');
    assert.ok(prepareEntry, 'prepareCuaDriver entrypoint must exist');
    assert.match(cua.archiveSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(cua.binarySha256 ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(cua.archiveSha256, cua.binarySha256, 'archive and extracted binary hashes must be independent');
    assert.equal(cua.sha256, undefined, 'the ambiguous legacy cuaDriver.sha256 field must stay removed');

    assert.match(prepareEntry[0], /assertPinnedCuaDriverChecksums\(cua\)/);
    assert.ok(
      prepareEntry[0].indexOf('assertPinnedCuaDriverChecksums(cua)')
        < prepareEntry[0].indexOf('alreadyPrepared()'),
      'prepare must validate both manifest pins before accepting an up-to-date marker',
    );
    assert.match(prepare, /actualArchiveSha256/);
    assert.match(prepare, /cua\.archiveSha256/);
    assert.match(prepare, /actualBinarySha256/);
    assert.match(prepare, /cua\.binarySha256/);

    assert.match(check, /assertPinnedCuaDriverChecksums\(cua\)/);
    assert.match(check, /cua\.archiveSha256/);
    assert.match(check, /actualBinarySha256/);
    assert.match(check, /cua\.binarySha256/);
    assert.doesNotMatch(
      check,
      /actual(?:Sha256|BinarySha256)\s*!==\s*cua\.archiveSha256/,
      'the extracted Mach-O must never be compared with the release archive checksum',
    );
  });
});
