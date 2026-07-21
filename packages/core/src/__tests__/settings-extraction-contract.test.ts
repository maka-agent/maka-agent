import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import * as botChatSettings from '../bot-chat-settings.js';
import * as core from '../index.js';
import {
  NETWORK_DEFAULTS,
  type NetworkSettings as LegacyRuntimeNetworkSettings,
  type RuntimeNetworkSettings,
} from '../settings/network-settings.js';
import * as settings from '../settings.js';
import type {
  AppNetworkSettings,
  AppSettings,
  NetworkSettings as LegacyAppNetworkSettings,
} from '../settings.js';

const REPO_ROOT = resolveRepoRoot();

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

function resolveRepoRoot(): string {
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, 'packages', 'core', 'src', 'settings.ts'))) return cwd;
  const fromWorkspace = resolve(cwd, '..', '..');
  if (existsSync(join(fromWorkspace, 'packages', 'core', 'src', 'settings.ts')))
    return fromWorkspace;
  return cwd;
}

describe('settings domain extraction contract', () => {
  test('keeps the existing settings and root bot-chat exports compatible', () => {
    assert.strictEqual(settings.BOT_READINESS_STATES, botChatSettings.BOT_READINESS_STATES);
    assert.strictEqual(settings.BOT_PROVIDERS, botChatSettings.BOT_PROVIDERS);
    assert.strictEqual(settings.BOT_DELIVERY_PROVIDERS, botChatSettings.BOT_DELIVERY_PROVIDERS);
    assert.strictEqual(settings.MAX_ALLOWED_USER_IDS, botChatSettings.MAX_ALLOWED_USER_IDS);
    assert.strictEqual(settings.createDefaultBotChannel, botChatSettings.createDefaultBotChannel);
    assert.strictEqual(settings.hasBotChannelCredentials, botChatSettings.hasBotChannelCredentials);
    assert.strictEqual(settings.normalizeAllowedUserIds, botChatSettings.normalizeAllowedUserIds);
    assert.strictEqual(
      settings.parseAllowedUserIdsFromText,
      botChatSettings.parseAllowedUserIdsFromText,
    );
    assert.strictEqual(core.BOT_PROVIDERS, botChatSettings.BOT_PROVIDERS);
    assert.strictEqual(core.createDefaultBotChannel, botChatSettings.createDefaultBotChannel);
  });

  test('gives persisted and runtime network contracts distinct canonical shapes', () => {
    const persisted: AppNetworkSettings = settings.createDefaultSettings().network;
    const legacy: LegacyAppNetworkSettings = persisted;
    const canonicalAgain: AppNetworkSettings = legacy;
    const runtime: RuntimeNetworkSettings = NETWORK_DEFAULTS;
    const legacyRuntime: LegacyRuntimeNetworkSettings = runtime;
    const canonicalRuntimeAgain: RuntimeNetworkSettings = legacyRuntime;
    const fromAppSettings: AppSettings['network'] = canonicalAgain;

    assert.equal('timeout' in persisted, false);
    assert.equal(canonicalRuntimeAgain.timeout, 30_000);
    assert.strictEqual(fromAppSettings, persisted);
  });

  test('keeps ownership in the leaf modules and composition in settings.ts', async () => {
    const [aggregate, botOwner, webSearchOwner, networkOwner, barrel] = await Promise.all([
      readRepo('packages/core/src/settings.ts'),
      readRepo('packages/core/src/bot-chat-settings.ts'),
      readRepo('packages/core/src/web-search.ts'),
      readRepo('packages/core/src/settings/network-settings.ts'),
      readRepo('packages/core/src/index.ts'),
    ]);

    assert.match(aggregate, /from '\.\/bot-chat-settings\.js'/);
    assert.match(aggregate, /botChat: createDefaultBotChatSettings\(\)/);
    assert.match(aggregate, /botChat: mergeBotChatSettings\(current\.botChat, patch\.botChat\)/);
    assert.match(aggregate, /botChat: normalizeBotChatSettings\(base\.botChat, value\.botChat\)/);
    assert.doesNotMatch(aggregate, /export type BotProvider =/);
    assert.doesNotMatch(aggregate, /export interface BotChannelSettings/);
    assert.doesNotMatch(aggregate, /function normalizeBotChannel/);
    assert.doesNotMatch(aggregate, /function coerceReadinessForCurrentState/);

    assert.match(botOwner, /export interface BotChannelSettings/);
    assert.match(botOwner, /function normalizeBotChannel/);
    assert.match(botOwner, /function coerceReadinessForCurrentState/);
    assert.doesNotMatch(botOwner, /from '\.\/settings\.js'/);
    assert.doesNotMatch(botOwner, /from 'node:/);

    assert.match(
      aggregate,
      /webSearch: mergeWebSearchSettings\(current\.webSearch, patch\.webSearch\)/,
    );
    assert.match(aggregate, /webSearch: normalizeWebSearchSettings\(base\.webSearch\)/);
    assert.doesNotMatch(aggregate, /function mergeWebSearchSettings/);
    assert.doesNotMatch(aggregate, /function normalizeWebSearchSettings/);
    assert.match(webSearchOwner, /export function mergeWebSearchSettings/);
    assert.match(webSearchOwner, /export function normalizeWebSearchSettings/);
    assert.doesNotMatch(webSearchOwner, /from '\.\/settings\.js'/);

    assert.match(aggregate, /export interface AppNetworkSettings/);
    assert.match(aggregate, /export type NetworkSettings = AppNetworkSettings/);
    assert.match(networkOwner, /export interface RuntimeNetworkSettings/);
    assert.match(networkOwner, /export type NetworkSettings = RuntimeNetworkSettings/);

    assert.match(barrel, /from '\.\/bot-chat-settings\.js'/);
    assert.doesNotMatch(barrel, /mergeBotChatSettings|normalizeBotChatSettings/);
  });

  test('points package-local bot consumers at the owner instead of the aggregate', async () => {
    const paths = [
      'packages/core/src/bot-events.ts',
      'packages/core/src/bot-onboarding.ts',
      'packages/core/src/bot-platform-hints.ts',
      'packages/core/src/capabilities.ts',
      'packages/core/src/plan-reminders.ts',
    ];
    const sources = await Promise.all(paths.map(readRepo));

    for (const [index, source] of sources.entries()) {
      assert.match(
        source,
        /from '\.\/bot-chat-settings\.js'/,
        `${paths[index]} must import its bot contract from the owner`,
      );
      assert.doesNotMatch(
        source,
        /from '\.\/settings\.js'/,
        `${paths[index]} must not depend on the aggregate settings module`,
      );
    }
  });
});
