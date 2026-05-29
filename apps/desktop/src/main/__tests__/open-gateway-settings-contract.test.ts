import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const settingsSource = readFileSync(
  join(process.cwd(), 'src/renderer/settings/SettingsModal.tsx'),
  'utf8',
);

describe('Open Gateway Settings endpoint contract', () => {
  it('lists every shipped gateway endpoint instead of stale capability copy', () => {
    assert.match(settingsSource, /16 个端点/);
    assert.doesNotMatch(settingsSource, /15 个端点/);
    assert.doesNotMatch(settingsSource, /14 个端点/);
    assert.doesNotMatch(settingsSource, /13 个端点/);
    assert.doesNotMatch(settingsSource, /12 个端点/);
    assert.doesNotMatch(settingsSource, /11 个端点/);
    assert.doesNotMatch(settingsSource, /6 类端点/);
    assert.match(settingsSource, /最近失败计数/);
    assert.match(settingsSource, /复制总览 curl/);
    assert.match(settingsSource, /Authorization: Bearer/);
    for (const endpoint of [
      'GET /health',
      'GET /v1/openapi.json',
      'GET /v1/state',
      'GET /v1/capabilities',
      'GET /v1/sessions',
      'GET /v1/sessions/state',
      'GET /v1/sessions/:id/messages',
      'GET /v1/sessions/:id/messages/state',
      'POST /v1/sessions/:id/messages',
      'GET /v1/sessions/:id/events',
      'GET /v1/sessions/:id/events/state',
      'GET /v1/events/state',
      'GET /v1/sessions/:id/incidents',
      'GET /v1/incidents',
      'GET /v1/incidents/state',
      'GET /v1/search/thread?q=...',
    ]) {
      assert.ok(settingsSource.includes(endpoint), `Settings should list ${endpoint}`);
    }
  });
});
