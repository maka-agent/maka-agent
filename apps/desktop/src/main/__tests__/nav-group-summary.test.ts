/**
 * Tests for `deriveNavGroupSummary` — the pure helper that produces the
 * short summary line rendered under each Settings nav group.
 *
 * Pins the H1 / H2 assertions from `notes/pr-health-0-audit-report.md`
 * (PR-HEALTH-1, msg `e4887ffd` lock):
 *
 *   - H1: '集成' group must say `已启用机器人` (NOT `机器人`), parallel to
 *     PR-UI-AUDIT-1's `已启用连接` for the AI group. The summary counts
 *     `channel.enabled` toggles; it does not measure operational readiness.
 *
 *   - H2: '数据与账号' group must NOT claim `凭据本地加密` when no
 *     connections exist — the prior fallback was a static reassurance
 *     that didn't reflect facts.
 *
 * Existing AI / 数据与账号 error-path behavior is also pinned so the
 * extraction (from inline SettingsModal helper into pure file) doesn't
 * regress.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AppSettings, LlmConnection } from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import { deriveNavGroupSummary } from '../../renderer/settings/nav-group-summary.js';

function connection(partial: Partial<LlmConnection> & { slug: string }): LlmConnection {
  return {
    name: partial.slug,
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...partial,
  };
}

function settingsWithBotsEnabled(enabledProviders: string[]): AppSettings {
  const base = createDefaultSettings();
  const channels = { ...base.botChat.channels };
  for (const provider of enabledProviders) {
    const key = provider as keyof typeof channels;
    if (channels[key]) {
      channels[key] = { ...channels[key], enabled: true };
    }
  }
  return {
    ...base,
    botChat: { channels },
  };
}

describe('deriveNavGroupSummary', () => {
  const baseSettings = createDefaultSettings();

  describe('AI group', () => {
    it('reports `等待启用连接` when no connection is enabled', () => {
      const summary = deriveNavGroupSummary({
        group: 'AI',
        connections: [],
        defaultSlug: null,
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '等待启用连接', tone: 'info' });
      assert.ok(!summary!.text.includes('尚未启用'), `must not read like unfinished setup copy: ${summary!.text}`);
    });

    it('reports error count when any enabled connection lastTestStatus=error', () => {
      const summary = deriveNavGroupSummary({
        group: 'AI',
        connections: [
          connection({ slug: 'a', enabled: true, lastTestStatus: 'error' }),
          connection({ slug: 'b', enabled: true, lastTestStatus: 'verified' }),
        ],
        defaultSlug: 'b',
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '1 个连接出错', tone: 'destructive' });
    });

    it('reports needs_reauth count when no errored connections', () => {
      const summary = deriveNavGroupSummary({
        group: 'AI',
        connections: [
          connection({ slug: 'a', enabled: true, lastTestStatus: 'needs_reauth' }),
        ],
        defaultSlug: 'a',
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '1 个需重登', tone: 'warning' });
    });

    it('reports `未设默认模型` when default slug does not match', () => {
      const summary = deriveNavGroupSummary({
        group: 'AI',
        connections: [connection({ slug: 'a', enabled: true })],
        defaultSlug: 'ghost',
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '未设默认模型', tone: 'warning' });
    });

    it('reports `N 个已启用连接` (NOT `可用`) for happy-path AI group', () => {
      // PR-UI-AUDIT-1 (@kenji msg 7a16aa0b): "可用" implied operational
      // readiness, but this counts `enabled` toggles only. Lock the
      // `已启用` wording to prevent regression to the operational claim.
      const summary = deriveNavGroupSummary({
        group: 'AI',
        connections: [
          connection({ slug: 'a', enabled: true, lastTestStatus: 'verified' }),
          connection({ slug: 'b', enabled: true, lastTestStatus: 'verified' }),
          connection({ slug: 'disabled', enabled: false }),
        ],
        defaultSlug: 'a',
        settings: baseSettings,
      });
      assert.ok(summary, 'expected summary');
      assert.equal(summary!.text, '2 个已启用连接');
      // Defensive: must NOT impersonate operational.
      assert.ok(!summary!.text.includes('可用'), `must not claim 可用: ${summary!.text}`);
      assert.equal(summary!.tone, undefined);
    });
  });

  describe('集成 group (H1 lock)', () => {
    it('reports `已启用机器人` (NOT just `机器人`) when bots are enabled', () => {
      // PR-HEALTH-1 (xuan msg e4887ffd, I4): same impersonation pattern
      // PR-UI-AUDIT-1 fixed for connections — channel.enabled count is
      // a toggle count, not operational claim. Lock parallel wording.
      const summary = deriveNavGroupSummary({
        group: '集成',
        connections: [],
        defaultSlug: null,
        settings: settingsWithBotsEnabled(['telegram', 'feishu']),
      });
      assert.ok(summary, 'expected summary');
      assert.ok(
        summary!.text.includes('2 个已启用机器人'),
        `expected "已启用机器人", got: ${summary!.text}`,
      );
      // Defensive: must NOT use bare `N 个机器人` form.
      assert.ok(
        !/\d+\s*个机器人/.test(summary!.text),
        `must not use bare "N 个机器人" form: ${summary!.text}`,
      );
    });

    it('reports `0 个已启用机器人` when no bots enabled', () => {
      const summary = deriveNavGroupSummary({
        group: '集成',
        connections: [],
        defaultSlug: null,
        settings: baseSettings,
      });
      assert.ok(summary, 'expected summary');
      assert.ok(summary!.text.includes('0 个已启用机器人'), `unexpected: ${summary!.text}`);
    });

    it('reports proxy state alongside bot count', () => {
      const settings: AppSettings = {
        ...baseSettings,
        network: {
          proxy: { ...baseSettings.network.proxy, enabled: true },
        },
      };
      const summary = deriveNavGroupSummary({
        group: '集成',
        connections: [],
        defaultSlug: null,
        settings,
      });
      assert.ok(summary, 'expected summary');
      assert.ok(summary!.text.startsWith('代理已开'), `unexpected: ${summary!.text}`);
    });
  });

  describe('数据与账号 group (H2 lock)', () => {
    it('reports `尚无凭据` when no connections exist (NOT `凭据本地加密`)', () => {
      // PR-HEALTH-1 (xuan msg e4887ffd, I5): the prior fallback claimed
      // `凭据本地加密` even when no credentials existed — a static
      // reassurance unsupported by facts. Reflect the empty state.
      const summary = deriveNavGroupSummary({
        group: '数据与账号',
        connections: [],
        defaultSlug: null,
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '尚无凭据', tone: 'info' });
    });

    it('reports `凭据本地加密` only when at least one connection exists and is healthy', () => {
      const summary = deriveNavGroupSummary({
        group: '数据与账号',
        connections: [connection({ slug: 'a', enabled: true, lastTestStatus: 'verified' })],
        defaultSlug: 'a',
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '凭据本地加密' });
    });

    it('reports `N 个凭据需处理` when there are errored / needs_reauth connections', () => {
      const summary = deriveNavGroupSummary({
        group: '数据与账号',
        connections: [
          connection({ slug: 'a', enabled: true, lastTestStatus: 'error' }),
          connection({ slug: 'b', enabled: true, lastTestStatus: 'needs_reauth' }),
        ],
        defaultSlug: 'a',
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '2 个凭据需处理', tone: 'destructive' });
    });

    it('uses warning tone when only needs_reauth (no errored)', () => {
      const summary = deriveNavGroupSummary({
        group: '数据与账号',
        connections: [connection({ slug: 'a', enabled: true, lastTestStatus: 'needs_reauth' })],
        defaultSlug: 'a',
        settings: baseSettings,
      });
      assert.deepEqual(summary, { text: '1 个凭据需处理', tone: 'warning' });
    });
  });

  describe('groups with no summary', () => {
    it('returns undefined for 基础', () => {
      assert.equal(
        deriveNavGroupSummary({
          group: '基础',
          connections: [],
          defaultSlug: null,
          settings: baseSettings,
        }),
        undefined,
      );
    });

    it('returns undefined for 其他', () => {
      assert.equal(
        deriveNavGroupSummary({
          group: '其他',
          connections: [],
          defaultSlug: null,
          settings: baseSettings,
        }),
        undefined,
      );
    });
  });
});
