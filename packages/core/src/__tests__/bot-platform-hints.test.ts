import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOT_PROVIDERS,
  botPlatformFromSessionLabels,
  buildBotPlatformPromptFragment,
  getBotPlatformPromptHint,
} from '../index.js';

describe('bot platform prompt hints', () => {
  test('locks one prompt hint for every bot provider', () => {
    for (const provider of BOT_PROVIDERS) {
      const hint = getBotPlatformPromptHint(provider);

      assert.equal(hint.platform, provider);
      assert.ok(hint.displayName.length > 0);
      assert.ok(hint.deliveryFormat.length > 0);
      assert.ok(hint.capabilityCaveat.length > 0);
      assert.ok(hint.systemPromptBullets.length >= 2);
    }
  });

  test('detects bot platform only from bot-labeled sessions', () => {
    assert.equal(botPlatformFromSessionLabels(['bot', 'telegram']), 'telegram');
    assert.equal(botPlatformFromSessionLabels(['telegram']), undefined);
    assert.equal(botPlatformFromSessionLabels(['bot', 'unknown']), undefined);
    assert.equal(botPlatformFromSessionLabels(undefined), undefined);
  });

  test('telegram prompt is plain-text and attachment-cautious', () => {
    const fragment = buildBotPlatformPromptFragment('telegram');

    assert.match(fragment, /trusted application metadata, not user-authored/);
    assert.match(fragment, /Platform: Telegram \(telegram\)/);
    assert.match(fragment, /Formatting profile: plain_text/);
    assert.match(fragment, /without parse_mode/);
    assert.match(fragment, /only discuss content that is explicitly present/);
  });

  test('prompt hints do not leak scaffold or future-bridge implementation language', () => {
    for (const provider of BOT_PROVIDERS) {
      const fragment = buildBotPlatformPromptFragment(provider);

      assert.doesNotMatch(
        fragment,
        /scaffold|live bridge|until .* enabled|not implemented|coming soon/i,
        `${provider} prompt hint must describe current runtime capability boundaries, not implementation roadmap`,
      );
    }
  });
});
