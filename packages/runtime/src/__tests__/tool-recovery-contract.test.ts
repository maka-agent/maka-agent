import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ToolRecoveryContractRegistry,
  type ToolRecoveryContract,
} from '../tool-recovery-contract.js';

describe('ToolRecoveryContractRegistry', () => {
  it('resolves an exact tool contract only when its durable recovery mode matches', () => {
    const contract: ToolRecoveryContract = {
      id: 'maka.tool.write.recovery',
      version: 1,
      mode: 'reconcile_then_decide',
    };
    const registry = new ToolRecoveryContractRegistry([{ toolName: 'Write', contract }]);

    assert.deepEqual(registry.resolve('Write', 'reconcile'), {
      status: 'available',
      contract,
    });
    assert.deepEqual(registry.resolve('Write', 'never_auto_retry'), {
      status: 'incompatible',
      contract,
      expectedRecoveryMode: 'reconcile',
      recordedRecoveryMode: 'never_auto_retry',
    });
    assert.deepEqual(registry.resolve('Unknown', 'reconcile'), { status: 'missing' });
  });

  it('rejects duplicate tool registrations instead of silently replacing a contract', () => {
    assert.throws(
      () =>
        new ToolRecoveryContractRegistry([
          {
            toolName: 'Write',
            contract: {
              id: 'maka.tool.write.recovery',
              version: 1,
              mode: 'reconcile_then_decide',
            },
          },
          {
            toolName: 'Write',
            contract: {
              id: 'maka.tool.write.recovery',
              version: 2,
              mode: 'reconcile_then_decide',
            },
          },
        ]),
      /duplicate tool recovery contract registration: Write/i,
    );
  });

  it('rejects malformed contract identities and versions', () => {
    for (const contract of [
      { id: '', version: 1, mode: 'manual_only' as const },
      { id: 'maka.tool.bash.manual', version: 0, mode: 'manual_only' as const },
    ]) {
      assert.throws(
        () => new ToolRecoveryContractRegistry([{ toolName: 'Bash', contract }]),
        /invalid tool recovery contract/i,
      );
    }
  });

  it('snapshots registrations so later caller mutation cannot change recovery decisions', () => {
    const contract = {
      id: 'maka.tool.read.replay',
      version: 1,
      mode: 'replay_safe_read' as const,
    };
    const registry = new ToolRecoveryContractRegistry([{ toolName: 'Read', contract }]);

    contract.id = 'changed-after-registration';
    contract.version = 2;

    const resolution = registry.resolve('Read', 'replay_safe');
    assert.equal(resolution.status, 'available');
    if (resolution.status === 'available') {
      assert.equal(resolution.contract.id, 'maka.tool.read.replay');
      assert.equal(resolution.contract.version, 1);
    }
  });
});
