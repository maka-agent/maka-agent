import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertPinnedCuaDriverChecksums,
  assertSafeTarEntries,
  assertSafeTarListing,
  cuaDriverDownloadUrl,
} from './prepare-cua-driver.mjs';
import { cuaDriverDistributionBlockers } from './check-cua-driver-bundle.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../apps/desktop/bundled-tools.json', import.meta.url)),
);
const cua = manifest.cuaDriver;

test('cua-driver release pins archive, binary, source, and license independently', () => {
  assertPinnedCuaDriverChecksums(cua);
  assert.notEqual(cua.archiveSha256, cua.binarySha256);
  assert.match(cua.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(cua.upstreamCommit, /^[a-f0-9]{40}$/);
  assert.match(cua.upstreamMergeCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(cua.architectures, ['arm64', 'x86_64']);
  assert.equal(cua.signature, 'adhoc');
  assert.equal(
    cuaDriverDownloadUrl(cua.tag, cua.asset),
    `https://github.com/${cua.repo}/releases/download/${cua.tag}/${cua.asset}`,
  );
});

test('tar entry validation rejects path traversal before extraction', () => {
  assertSafeTarEntries(['bundle/cua-driver', 'bundle/LICENSE.md']);
  assert.throws(() => assertSafeTarEntries(['../../tmp/escape']));
  assert.throws(() => assertSafeTarEntries(['/absolute/path']));
  assert.throws(() => assertSafeTarEntries(['windows\\escape']));
  assertSafeTarListing([
    'drwxr-xr-x user/group 0 2026-01-01 00:00 bundle/',
    '-rwxr-xr-x user/group 1 2026-01-01 00:00 bundle/cua-driver',
  ]);
  assert.throws(() => assertSafeTarListing([
    'lrwxr-xr-x user/group 0 2026-01-01 00:00 bundle/link -> /tmp/escape',
  ]));
});

test('tracked license and source metadata match the manifest pins', async () => {
  const license = await readFile(new URL(
    '../apps/desktop/resources/licenses/cua-driver/LICENSE.md',
    import.meta.url,
  ));
  const sourceBytes = await readFile(new URL(
    '../apps/desktop/resources/licenses/cua-driver/SOURCE.json',
    import.meta.url,
  ));
  assert.equal(sha256(license), cua.licenseSha256);
  assert.equal(sha256(sourceBytes), cua.sourceSha256);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  assert.equal(source.repository, cua.repo);
  assert.equal(source.upstreamCommit, cua.upstreamCommit);
  assert.equal(source.sourceCommit, cua.sourceCommit);
  assert.equal(source.patchPullRequest, cua.patchPullRequest);
  assert.equal(source.cargoLockSha256, cua.cargoLockSha256);
});

test('artifact checks remain separate from the distribution release gate', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const checkSource = await readFile(
    new URL('./check-cua-driver-bundle.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(pkg.scripts['check:cua-driver-artifact']);
  assert.doesNotMatch(pkg.scripts['check:release'], /cua-driver/);
  assert.match(checkSource, /releaseSigningReady:\s*false/);
  assert.match(checkSource, /codesign/);
  assert.doesNotMatch(checkSource, /notarytool|stapler|Developer ID Application/);
  assert.deepEqual(cuaDriverDistributionBlockers(cua), [
    'developer_id_signature',
    'notarization',
    'artifact_attestation',
    'build_provenance',
    'third_party_notices',
    'distribution_ready',
  ]);
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
