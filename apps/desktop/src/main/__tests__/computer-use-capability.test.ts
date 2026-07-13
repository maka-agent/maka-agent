import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd(), '..', '..');

describe('Desktop Computer Use production wiring', () => {
  it('registers the function harness without presentation or provider adapters', async () => {
    const main = await readFile(
      resolve(ROOT, 'apps/desktop/src/main/main.ts'),
      'utf8',
    );
    assert.match(main, /createComputerUseHost/);
    assert.match(main, /computerUseTools/);
    assert.match(main, /id:\s*'computer_use'/);
    assert.doesNotMatch(main, /createComputerUseOverlayHook/);
    assert.doesNotMatch(main, /createAnthropicComputerHarness|createKimiComputerHarness|createMiniMaxComputerHarness/);
  });

  it('clears Runtime and executor ownership at every turn/session boundary', async () => {
    const main = await readFile(
      resolve(ROOT, 'apps/desktop/src/main/main.ts'),
      'utf8',
    );
    assert.match(main, /sessions:stop[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /sessions:archive[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /sessions:remove[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /isTurnStatusChangingSessionEvent[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /catch \(error\)[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /Promise\.allSettled\(\[[\s\S]*computerUse\.backend\?\.dispose/);
  });

  it('reports scoped approval and live service health instead of binary-only healthy', async () => {
    const [snapshot, main] = await Promise.all([
      readFile(resolve(ROOT, 'apps/desktop/src/main/capability-snapshot.ts'), 'utf8'),
      readFile(resolve(ROOT, 'apps/desktop/src/main/main.ts'), 'utf8'),
    ]);
    const capability = snapshot.match(
      /function computerUseCapability[\s\S]*?(?=function officeDocumentsCapability)/,
    )?.[0];
    assert.ok(capability, 'Computer Use capability block must exist');
    assert.match(capability, /required_scoped_lease/);
    assert.match(capability, /input\?\.health\.state/);
    assert.doesNotMatch(capability, /required_per_action/);
    assert.match(main, /computerUse\.backend\?\.serviceState/);
    assert.match(main, /computerUseServiceHealth/);
  });
});
