import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  LOCAL_MEMORY_MAX_BYTES,
  buildLocalMemoryPromptBody,
  defaultLocalMemoryMarkdown,
  defaultLocalMemorySettings,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
} from '../local-memory.js';

describe('local MEMORY.md contract', () => {
  it('defaults file enabled but agent read disabled', () => {
    const settings = defaultLocalMemorySettings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.agentReadEnabled, false);
  });

  it('normalizes malformed settings fail-closed for agent reads', () => {
    assert.deepEqual(normalizeLocalMemorySettings(null), {
      enabled: true,
      agentReadEnabled: false,
    });
    assert.deepEqual(normalizeLocalMemorySettings({ enabled: false, agentReadEnabled: 'yes' }), {
      enabled: false,
      agentReadEnabled: false,
    });
  });

  it('parses heading entries and best-effort metadata comments', () => {
    const parsed = parseLocalMemoryMarkdown([
      '# Maka Memory',
      '',
      '## 偏好',
      '<!-- maka-memory: id=pref-1 origin=manual createdAt=1700000000000 -->',
      '喜欢简洁回答。',
      '',
      '## 手写条目',
      '没有 metadata 也要显示。',
    ].join('\n'));
    assert.equal(parsed.safeMode, false);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.activeEntries.length, 2);
    assert.equal(parsed.archivedEntries.length, 0);
    assert.equal(parsed.entries[0]?.id, 'pref-1');
    assert.equal(parsed.entries[0]?.origin, 'manual');
    assert.equal(parsed.entries[0]?.status, 'active');
    assert.equal(parsed.entries[0]?.createdAt, 1700000000000);
    assert.deepEqual(parsed.entries[0]?.tags, []);
    assert.equal(parsed.entries[1]?.origin, 'unknown');
    assert.match(parsed.entries[1]?.content ?? '', /metadata/);
  });

  it('parses V0.2 metadata fail-open and splits archived entries', () => {
    const parsed = parseLocalMemoryMarkdown([
      '# Maka Memory',
      '',
      '## Active preference',
      '<!-- maka-memory: id=pref-active origin=imported createdAt=1700000000000 updatedAt=1700000001000 status=active tags=work,AI,work decayTtlMs=86400000 unknownField=ok -->',
      'Keep answers concise.',
      '',
      '## Archived preference',
      '<!-- maka-memory: id=pref-old origin=extracted status=archived tags=old -->',
      'Do not use this anymore.',
    ].join('\n'));

    assert.equal(parsed.safeMode, false);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.activeEntries.length, 1);
    assert.equal(parsed.archivedEntries.length, 1);
    assert.equal(parsed.activeEntries[0]?.origin, 'imported');
    assert.equal(parsed.activeEntries[0]?.updatedAt, 1700000001000);
    assert.deepEqual(parsed.activeEntries[0]?.tags, ['work', 'ai']);
    assert.equal(parsed.activeEntries[0]?.decayTtlMs, 86400000);
    assert.equal(parsed.archivedEntries[0]?.origin, 'extracted');
    assert.equal(parsed.archivedEntries[0]?.status, 'archived');
  });

  it('builds prompt body from active entries only and omits metadata comments', () => {
    const body = buildLocalMemoryPromptBody([
      '# Maka Memory',
      '',
      '## Keep',
      '<!-- maka-memory: id=keep origin=manual status=active tags=style -->',
      'Prefer direct answers.',
      '',
      '## Archived',
      '<!-- maka-memory: id=old origin=manual status=archived -->',
      'This should not enter the model context.',
    ].join('\n'));

    assert.ok(body);
    assert.match(body, /## Keep/);
    assert.match(body, /Tags: style/);
    assert.match(body, /Prefer direct answers/);
    assert.doesNotMatch(body, /maka-memory|Archived|should not enter/);
  });

  it('does not apply UI preview truncation to the prompt body', () => {
    const longPreference = `${'a'.repeat(520)}tail-marker`;
    const body = buildLocalMemoryPromptBody([
      '# Maka Memory',
      '',
      '## Long preference',
      '<!-- maka-memory: id=long origin=manual status=active -->',
      longPreference,
    ].join('\n'));

    assert.ok(body);
    assert.match(body, /tail-marker/);
  });

  it('returns safe mode instead of parsing oversized content', () => {
    const parsed = parseLocalMemoryMarkdown('x'.repeat(LOCAL_MEMORY_MAX_BYTES + 1));
    assert.equal(parsed.safeMode, true);
    assert.equal(parsed.reason, 'oversize');
    assert.equal(parsed.entries.length, 0);
  });

  it('default template is parseable and manual', () => {
    const parsed = parseLocalMemoryMarkdown(defaultLocalMemoryMarkdown(1700000000000));
    assert.equal(parsed.safeMode, false);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.origin, 'manual');
  });
});
