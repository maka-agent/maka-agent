import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MacosSeatbeltBackend,
  SandboxManager,
  buildSeatbeltPolicy,
  createDefaultSandboxManager,
} from '../index.js';
import {
  MacosSeatbeltBackend as MacosSeatbeltBackendFromSubpath,
  SandboxManager as SandboxManagerFromSubpath,
  buildSeatbeltPolicy as buildSeatbeltPolicyFromSubpath,
  createDefaultSandboxManager as createDefaultSandboxManagerFromSubpath,
} from '../sandbox/index.js';

describe('runtime sandbox exports', () => {
  it('exports sandbox APIs from the runtime barrel and sandbox subpath', () => {
    assert.equal(SandboxManager, SandboxManagerFromSubpath);
    assert.equal(MacosSeatbeltBackend, MacosSeatbeltBackendFromSubpath);
    assert.equal(buildSeatbeltPolicy, buildSeatbeltPolicyFromSubpath);
    assert.equal(createDefaultSandboxManager, createDefaultSandboxManagerFromSubpath);
  });
});
