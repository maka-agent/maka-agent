import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MacosSeatbeltBackend,
  LinuxBubblewrapBackend,
  SandboxManager,
  buildSeatbeltPolicy,
  buildNetworkSeccompFilter,
  createDefaultSandboxManager,
  createBuiltinSandboxManager,
} from '../index.js';
import {
  MacosSeatbeltBackend as MacosSeatbeltBackendFromSubpath,
  LinuxBubblewrapBackend as LinuxBubblewrapBackendFromSubpath,
  SandboxManager as SandboxManagerFromSubpath,
  buildSeatbeltPolicy as buildSeatbeltPolicyFromSubpath,
  buildNetworkSeccompFilter as buildNetworkSeccompFilterFromSubpath,
  createDefaultSandboxManager as createDefaultSandboxManagerFromSubpath,
  createBuiltinSandboxManager as createBuiltinSandboxManagerFromSubpath,
} from '../sandbox/index.js';

describe('runtime sandbox exports', () => {
  it('exports sandbox APIs from the runtime barrel and sandbox subpath', () => {
    assert.equal(SandboxManager, SandboxManagerFromSubpath);
    assert.equal(MacosSeatbeltBackend, MacosSeatbeltBackendFromSubpath);
    assert.equal(LinuxBubblewrapBackend, LinuxBubblewrapBackendFromSubpath);
    assert.equal(buildSeatbeltPolicy, buildSeatbeltPolicyFromSubpath);
    assert.equal(buildNetworkSeccompFilter, buildNetworkSeccompFilterFromSubpath);
    assert.equal(createDefaultSandboxManager, createDefaultSandboxManagerFromSubpath);
    assert.equal(createBuiltinSandboxManager, createBuiltinSandboxManagerFromSubpath);
  });
});
