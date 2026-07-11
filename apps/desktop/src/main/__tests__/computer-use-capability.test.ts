import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const CAPABILITY_SNAPSHOT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'capability-snapshot.ts');
const MAIN = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');

describe('Computer Use capability contract', () => {
  it('reports live backend readiness instead of the retired unavailable scaffold', async () => {
    const [snapshot, main] = await Promise.all([
      readFile(CAPABILITY_SNAPSHOT, 'utf8'),
      readFile(MAIN, 'utf8'),
    ]);
    const capabilityBlock = snapshot.match(
      /function computerUseCapability\([\s\S]*?\n}\n\nfunction officeDocumentsCapability/,
    );

    assert.ok(capabilityBlock, 'Computer Use capability builder must exist');
    assert.match(snapshot, /computerUseBackendId\?:\s*'cua-driver'\s*\|\s*'none'/);
    assert.match(snapshot, /computerUseCapability\(input\.computerUseBackendId/);
    assert.match(capabilityBlock[0], /id:\s*'computer_use'/);
    assert.match(capabilityBlock[0], /const available = backendId === 'cua-driver'/);
    assert.match(capabilityBlock[0], /state:\s*available\s*\?\s*'enabled'\s*:\s*'not_available'/);
    assert.match(capabilityBlock[0], /state:\s*'healthy'/);
    assert.match(capabilityBlock[0], /source:\s*'runtime'/);
    assert.doesNotMatch(capabilityBlock[0], /scaffold|当前不可执行/);

    const backendWires = main.match(/computerUseBackendId:\s*computerUse\.backendId/g) ?? [];
    assert.equal(backendWires.length, 2, 'capability and health snapshots must share the selected live backend id');
  });
});
