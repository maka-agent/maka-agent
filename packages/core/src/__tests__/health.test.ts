import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  buildHealthSnapshot,
  healthSignalFromCapability,
  healthSignalFromConnection,
  isHealthSignalStatus,
  type HealthSignal,
} from '../health.js';
import type { CapabilitySnapshot } from '../capabilities.js';
import type { LlmConnection } from '../llm-connections.js';

describe('HealthSignal contract', () => {
  test('locks health status guard and summary counts', () => {
    expect(isHealthSignalStatus('ok')).toBe(true);
    expect(isHealthSignalStatus('operational')).toBe(false);

    const snapshot = buildHealthSnapshot(10, [
      signal('a', 'ok'),
      signal('b', 'warning'),
      signal('c', 'warning'),
      signal('d', 'unknown'),
    ]);

    expect(snapshot.summary).toEqual({
      ok: 1,
      info: 0,
      warning: 2,
      error: 0,
      unknown: 1,
    });
  });

  test('verified LLM connection is validation health, not runtime operational', () => {
    const result = healthSignalFromConnection(connection({
      lastTestStatus: 'verified',
      lastTestAt: '2026-05-22T07:30:00.000Z',
    }), 20);

    expect(result.status).toBe('ok');
    expect(result.layer).toBe('validation');
    expect(result.source).toBe('connection_test');
    expect(result.message).toBe('Credential and endpoint validation passed.');
    expect(result.detail).toContain('does not mean an agent send/stream/abort path is operational');
  });

  test('missing default model blocks send at configuration layer', () => {
    const result = healthSignalFromConnection(connection({ defaultModel: '' }), 20);

    expect(result.status).toBe('warning');
    expect(result.layer).toBe('configuration');
    expect(result.blocksSend).toBe(true);
  });

  test('capability denied and degraded remain distinct health errors', () => {
    const denied = healthSignalFromCapability(capability('computer_use', 'denied', {
      osPermissions: [{ id: 'accessibility', required: true, status: 'denied' }],
    }));
    const degraded = healthSignalFromCapability(capability('bot:telegram', 'degraded'));

    expect(denied.status).toBe('error');
    expect(denied.layer).toBe('permission');
    expect(denied.message).toBe('Capability is blocked by a required permission.');
    expect(degraded.status).toBe('error');
    expect(degraded.layer).toBe('runtime_probe');
    expect(degraded.message).toBe('Capability runtime probe is degraded.');
    expect(degraded.scope).toBe('bot');
  });
});

function signal(id: string, status: HealthSignal['status']): HealthSignal {
  return {
    id,
    label: id,
    scope: 'app',
    layer: 'runtime_probe',
    status,
    source: 'runtime_probe',
    checkedAt: 1,
    message: id,
  };
}

function connection(patch: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'zai',
    name: 'Z.ai',
    providerType: 'zai-coding-plan',
    defaultModel: 'glm-4.7',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function capability(
  id: CapabilitySnapshot['id'],
  readiness: CapabilitySnapshot['readiness'],
  patch: Partial<CapabilitySnapshot> = {},
): CapabilitySnapshot {
  return {
    id,
    label: id,
    readiness,
    feature: { state: 'enabled', source: 'settings' },
    configuration: { state: 'present', source: 'settings' },
    osPermissions: [],
    actionApproval: { state: 'required_per_action', source: 'capability_policy' },
    memoryAcceptance: { state: 'not_applicable', source: 'not_applicable' },
    runtimeProbe: { state: readiness === 'degraded' ? 'degraded' : 'not_run', source: 'runtime_probe' },
    canRevoke: false,
    canPause: false,
    auditEvents: [],
    updatedAt: 1,
    ...patch,
  };
}
