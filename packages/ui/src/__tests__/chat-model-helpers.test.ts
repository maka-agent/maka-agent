import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderType } from '@maka/core';
import { modelMenuGroups, type ChatModelChoice } from '../chat-model-helpers.js';

function choice(connectionSlug: string, providerType: ProviderType, model: string): ChatModelChoice {
  return { connectionSlug, providerType, model };
}

test('single connection per provider: heading is just the short label', () => {
  const groups = modelMenuGroups([
    choice('openai-main', 'openai', 'gpt-5.5'),
    choice('anthropic-main', 'anthropic', 'claude-opus-4-8'),
  ]);
  assert.deepEqual(
    groups.map((g) => g.heading).sort(),
    ['Anthropic', 'OpenAI'],
  );
});

test('same provider, multiple connections: headings are disambiguated by slug', () => {
  const groups = modelMenuGroups([
    choice('openai-work', 'openai', 'gpt-5.5'),
    choice('openai-personal', 'openai', 'gpt-5.5'),
  ]);
  assert.equal(groups.length, 2);
  const headings = groups.map((g) => g.heading);
  assert.equal(new Set(headings).size, 2, 'two same-provider connections must read as distinct rows');
  for (const h of headings) assert.match(h, /^OpenAI · openai-(work|personal)$/);
});

test('cross-provider same model name stays in separate, distinguishable groups', () => {
  // `gpt-5.5` is reachable both via an OpenAI api key and a Codex subscription;
  // the user must be able to tell which connection a row belongs to.
  const groups = modelMenuGroups([
    choice('openai-main', 'openai', 'gpt-5.5'),
    choice('codex-sub', 'codex-subscription', 'gpt-5.5'),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups.map((g) => g.heading)).size, 2);
});

test('headings never leak an account email (no @), even with slug disambiguation', () => {
  // modelMenuGroups never receives connection.name, so a leak is impossible by
  // construction; this guards against a future regression that reintroduces it.
  const groups = modelMenuGroups([
    choice('openai-a', 'openai', 'gpt-5.5'),
    choice('openai-b', 'openai', 'gpt-5.5'),
    choice('claude-sub', 'claude-subscription', 'claude-opus-4-8'),
  ]);
  for (const g of groups) assert.ok(!g.heading.includes('@'), `heading "${g.heading}" looks like it leaks an email`);
});
