import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSettingsCombinedSourceSync } from './settings-contract-source-helpers.js';

const settingsSource = readSettingsCombinedSourceSync();

describe('Open Gateway Settings endpoint contract', () => {
  it('lists every shipped gateway endpoint instead of stale capability copy', () => {
    assert.match(settingsSource, /19 个端点/);
    assert.doesNotMatch(settingsSource, /18 个端点/);
    assert.doesNotMatch(settingsSource, /17 个端点/);
    assert.doesNotMatch(settingsSource, /16 个端点/);
    assert.doesNotMatch(settingsSource, /15 个端点/);
    assert.doesNotMatch(settingsSource, /14 个端点/);
    assert.doesNotMatch(settingsSource, /13 个端点/);
    assert.doesNotMatch(settingsSource, /12 个端点/);
    assert.doesNotMatch(settingsSource, /11 个端点/);
    assert.doesNotMatch(settingsSource, /6 类端点/);
    assert.match(settingsSource, /最近失败计数/);
    assert.match(settingsSource, /复制总览 curl/);
    assert.match(settingsSource, /复制接口说明 curl/);
    assert.match(settingsSource, /复制单会话状态 curl/);
    assert.match(settingsSource, /复制事件流 curl/);
    assert.match(settingsSource, /复制最近事件 curl/);
    assert.match(settingsSource, /复制最近请求 curl/);
    assert.match(settingsSource, /Authorization: Bearer/);
    assert.ok(settingsSource.includes('/v1/sessions/${sessionId}/state'));
    assert.ok(settingsSource.includes('/v1/sessions/${sessionId}/events/recent'));
    assert.ok(settingsSource.includes('/v1/requests/recent'));
    assert.match(settingsSource, /Accept: text\/event-stream/);
    assert.match(settingsSource, /curl -N -sS/);
    assert.match(settingsSource, /encodeURIComponent\(eventSessionId\.trim\(\)\)/);
    for (const endpoint of [
      'GET /health',
      'GET /v1/openapi.json',
      'GET /v1/state',
      'GET /v1/capabilities',
      'GET /v1/sessions',
      'GET /v1/sessions/state',
      'GET /v1/sessions/:id/state',
      'GET /v1/sessions/:id/messages',
      'GET /v1/sessions/:id/messages/state',
      'POST /v1/sessions/:id/messages',
      'GET /v1/sessions/:id/events',
      'GET /v1/sessions/:id/events/state',
      'GET /v1/sessions/:id/events/recent',
      'GET /v1/events/state',
      'GET /v1/requests/recent',
      'GET /v1/sessions/:id/incidents',
      'GET /v1/incidents',
      'GET /v1/incidents/state',
      'GET /v1/search/thread?q=...',
    ]) {
      assert.ok(settingsSource.includes(endpoint), `Settings should list ${endpoint}`);
    }
  });

  it('surfaces clipboard failures for every Open Gateway copy action', () => {
    const helper = settingsSource.match(/async function copyGatewayText[\s\S]*?async function copyBaseUrl/)?.[0] ?? '';
    assert.match(helper, /if \(!gatewayCopyGuard\.begin\(action\)\) return/);
    assert.match(helper, /setCopyingGatewayAction\(action\)/);
    assert.match(helper, /if \(openGatewayMountedRef\.current\) \{[\s\S]*setCopyingGatewayAction\(null\)/);
    assert.match(helper, /try \{[\s\S]*navigator\.clipboard\.writeText\(text\)[\s\S]*if \(openGatewayMountedRef\.current\) \{[\s\S]*toast\.success\(successTitle, successDetail\)/);
    assert.match(helper, /catch \{[\s\S]*if \(openGatewayMountedRef\.current\) \{[\s\S]*toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\)/);
    assert.match(helper, /剪贴板不可用或被系统拒绝。/);
    assert.doesNotMatch(
      helper,
      /error instanceof Error|error\.message|String\(error\)/,
      'Open Gateway clipboard failures must not surface raw DOMException messages',
    );

    const gatewayBlock = settingsSource.match(/function OpenGatewaySettingsPage[\s\S]*?function presentGatewayStatus/)?.[0] ?? '';
    assert.match(gatewayBlock, /copyGatewayText\('base-url', baseUrl, '已复制网关地址'/);
    assert.match(gatewayBlock, /copyGatewayText\('overview-curl', command, '已复制总览 curl'/);
    assert.match(gatewayBlock, /copyGatewayText\('openapi-curl', command, '已复制接口说明 curl'/);
    assert.match(gatewayBlock, /copyGatewayText\('session-state-curl', command, '已复制单会话状态 curl'/);
    assert.match(gatewayBlock, /copyGatewayText\('event-stream-curl', command, '已复制事件流 curl'/);
    assert.match(gatewayBlock, /copyGatewayText\('recent-events-curl', command, '已复制最近事件 curl'/);
    assert.match(gatewayBlock, /copyGatewayText\('recent-requests-curl', command, '已复制最近请求 curl'/);
    assert.match(gatewayBlock, /const gatewayCopyDisabled = Boolean\(copyingGatewayAction\)/);
    assert.match(gatewayBlock, /disabled=\{gatewayCopyDisabled\}/);
    assert.match(gatewayBlock, /disabled=\{!gatewayDraft\.token \|\| gatewayCopyDisabled\}/);
    assert.match(gatewayBlock, /isCopyingGatewayAction\('base-url'\) \? '复制中…' : '复制地址'/);
    // Round 11: the seven page-level curl buttons collapsed into per-endpoint
    // row actions — each endpoint row carries its own 复制 curl button, so the
    // busy label is the shared '复制 curl' form on the row.
    assert.match(gatewayBlock, /isCopyingGatewayAction\('recent-requests-curl'\) \? '复制中…' : '复制 curl'/);
    assert.doesNotMatch(
      gatewayBlock,
      /'复制最近请求 curl'|'复制总览 curl'/,
      'curl copies live on their endpoint rows, not in a page-level button wall',
    );
  });

  it('does not write Open Gateway copy feedback after the Settings page unmounts', () => {
    const gatewayBlock = settingsSource.match(/function OpenGatewaySettingsPage[\s\S]*?function presentGatewayStatus/)?.[0] ?? '';
    const helper = settingsSource.match(/async function copyGatewayText[\s\S]*?async function copyBaseUrl/)?.[0] ?? '';

    assert.match(
      gatewayBlock,
      /const gatewayCopyGuard = useActionGuard<string>\(\);[\s\S]*mountedRef: openGatewayMountedRef,/,
      'Open Gateway Settings must track mounted ownership (from the shared draft hook) and hold copy ownership in the shared guard (released on unmount)',
    );
    assert.match(
      helper,
      /await navigator\.clipboard\.writeText\(text\);[\s\S]*if \(openGatewayMountedRef\.current\) \{[\s\S]*toast\.success\(successTitle, successDetail\);/,
      'Open Gateway copy success toast must only fire while the page is still mounted',
    );
    assert.match(
      helper,
      /catch \{[\s\S]*if \(openGatewayMountedRef\.current\) \{[\s\S]*toast\.error\('复制失败', '剪贴板不可用或被系统拒绝。'\);/,
      'Open Gateway copy failure toast must only fire while the page is still mounted',
    );
    assert.match(
      helper,
      /finally \{[\s\S]*gatewayCopyGuard\.finish\(\);[\s\S]*if \(openGatewayMountedRef\.current\) \{[\s\S]*setCopyingGatewayAction\(null\);/,
      'Open Gateway copy cleanup must release the guard but not write React state after unmount',
    );
  });

  it('surfaces Open Gateway runtime status load failures instead of showing normal false state', () => {
    const gatewayBlock = settingsSource.match(/function OpenGatewaySettingsPage[\s\S]*?function presentGatewayStatus/)?.[0] ?? '';
    assert.match(
      gatewayBlock,
      /statusLoadError/,
      'Open Gateway Settings must keep an explicit runtime-status load error state',
    );
    assert.match(
      gatewayBlock,
      /window\.maka\.gateway[\s\S]*\.status\(\)[\s\S]*catch\(\(error\) => \{[\s\S]*settingsActionErrorMessage\(error\)[\s\S]*setStatusLoadError\(message\)[\s\S]*toast\.error\('读取开放网关状态失败', message\)/,
      'initial gateway.status() failures must surface visibly instead of being swallowed',
    );
    assert.match(
      gatewayBlock,
      /subscribeStatusChanges\(\(next\) => \{[\s\S]*setStatus\(next\)[\s\S]*setStatusLoadError\(null\)/,
      'the visible status-load error should clear when a later runtime status event arrives',
    );
    assert.match(
      gatewayBlock,
      /role="alert"[\s\S]*开放网关运行状态读取失败：\{statusLoadError\}/,
      'status-load failures must render an accessible inline alert',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /\.catch\(\(\) => \{\}\)/,
      'gateway.status() failures must not be swallowed silently',
    );
  });
});
