import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  extractToolCommand,
  formatAsKeyValueLines,
  formatQuietJsonValue,
  formatToolInvocationLine,
  type UiLocale,
} from '../tool-quiet-preview.js';

describe('tool-quiet-preview', () => {
  describe('extractToolCommand', () => {
    it('extracts command from args', () => {
      assert.equal(extractToolCommand({ command: 'ls -la' }), 'ls -la');
      assert.equal(extractToolCommand({ cmd: 'echo hi' }), 'echo hi');
      assert.equal(extractToolCommand({ script: 'run.sh' }), 'run.sh');
    });
    it('returns undefined for non-command shapes', () => {
      assert.equal(extractToolCommand({ path: '/foo' }), undefined);
      assert.equal(extractToolCommand(undefined), undefined);
      assert.equal(extractToolCommand('string'), undefined);
    });
  });

  describe('formatToolInvocationLine', () => {
    it('extracts command for Bash', () => {
      const line = formatToolInvocationLine(
        { toolName: 'Bash', args: { command: 'npm test' } },
        'en',
      );
      assert.equal(line, 'npm test');
    });
    it('extracts path for Read', () => {
      const line = formatToolInvocationLine(
        { toolName: 'Read', args: { path: '/foo/bar.ts' } },
        'en',
      );
      assert.equal(line, '/foo/bar.ts');
    });
    it('extracts name for Skill (Bug 1 fix)', () => {
      const line = formatToolInvocationLine(
        { toolName: 'Skill', args: { name: 'my-skill' } },
        'en',
      );
      assert.equal(line, 'my-skill');
    });
    it('uses zh strings for WriteStdin', () => {
      const line = formatToolInvocationLine(
        {
          toolName: 'WriteStdin',
          args: { inputPreview: { text: 'echo hi', bytes: 7, truncated: false } },
        },
        'zh',
      );
      assert.match(line!, /后台终端交互/);
    });
    it('uses en strings for WriteStdin', () => {
      const line = formatToolInvocationLine(
        {
          toolName: 'WriteStdin',
          args: { inputPreview: { text: 'echo hi', bytes: 7, truncated: false } },
        },
        'en',
      );
      assert.match(line!, /Background terminal interaction/);
    });
    it('falls back to key:value lines, not JSON', () => {
      const line = formatToolInvocationLine(
        { toolName: 'Custom', args: { alpha: 1, beta: 'two' } },
        'en',
      );
      assert.match(line!, /alpha: 1/);
      assert.match(line!, /beta: two/);
      assert.doesNotMatch(line!, /\{/);
    });
  });

  describe('formatQuietJsonValue', () => {
    it('renders empty for null/undefined', () => {
      assert.equal(formatQuietJsonValue(null, 'zh').body, '（空）');
      assert.equal(formatQuietJsonValue(null, 'en').body, '(empty)');
    });
    it('renders Write/Edit result with locale strings', () => {
      const zh = formatQuietJsonValue({ ok: true, path: '/foo.ts', bytes: 42 }, 'zh');
      assert.equal(zh.headline, '/foo.ts');
      assert.match(zh.body, /已完成/);
      assert.match(zh.body, /42 B/);

      const en = formatQuietJsonValue({ ok: true, path: '/foo.ts', bytes: 42 }, 'en');
      assert.equal(en.headline, '/foo.ts');
      assert.match(en.body, /done/);
      assert.match(en.body, /42 B/);
    });
    it('renders replacements with locale strings', () => {
      const zh = formatQuietJsonValue({ ok: true, path: '/foo.ts', replacements: 3 }, 'zh');
      assert.match(zh.body, /3 处/);
      const en = formatQuietJsonValue({ ok: true, path: '/foo.ts', replacements: 3 }, 'en');
      assert.match(en.body, /3 replacements/);
    });
    it('renders list payloads', () => {
      const { body } = formatQuietJsonValue({ matches: ['a.ts:1:foo', 'b.ts:2:bar'] }, 'en');
      assert.match(body, /a\.ts:1:foo/);
      assert.match(body, /b\.ts:2:bar/);
    });
    it('keeps error diagnostics when a list is present', () => {
      const { body } = formatQuietJsonValue({ results: [], error: 'denied', ok: false }, 'en');
      assert.match(body, /error: denied/);
      assert.match(body, /ok: false/);
    });
    it('redacts sensitive keys', () => {
      const { body } = formatQuietJsonValue({ password: 'correct-horse', ok: true }, 'en');
      assert.doesNotMatch(body, /correct-horse/);
      assert.match(body, /redacted/i);
    });
  });

  describe('formatAsKeyValueLines', () => {
    it('redacts secrets embedded in keys', () => {
      const out = formatAsKeyValueLines({ 'password=secret': true }, 0, 'en');
      assert.doesNotMatch(out, /secret/);
      assert.match(out, /redacted/i);
    });
  });
});
