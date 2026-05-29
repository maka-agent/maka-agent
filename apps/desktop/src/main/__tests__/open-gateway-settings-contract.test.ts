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
    assert.match(settingsSource, /12 个端点/);
    assert.doesNotMatch(settingsSource, /11 个端点/);
    assert.doesNotMatch(settingsSource, /6 类端点/);
    assert.match(settingsSource, /最近失败计数/);
    for (const endpoint of [
      'GET /health',
      'GET /v1/capabilities',
      'GET /v1/sessions',
      'GET /v1/sessions/state',
      'GET /v1/sessions/:id/messages',
      'GET /v1/sessions/:id/messages/state',
      'POST /v1/sessions/:id/messages',
      'GET /v1/sessions/:id/events',
      'GET /v1/sessions/:id/events/state',
      'GET /v1/sessions/:id/incidents',
      'GET /v1/incidents',
      'GET /v1/search/thread?q=...',
    ]) {
      assert.ok(settingsSource.includes(endpoint), `Settings should list ${endpoint}`);
    }
  });
});
