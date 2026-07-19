import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  LOCAL_MEMORY_MAX_BYTES,
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  appendManualLocalMemoryEntryDraft,
  approveLocalMemoryProposalDraft,
  buildLocalMemoryPromptBody,
  defaultLocalMemoryMarkdown,
  defaultLocalMemorySettings,
  findLocalMemoryEntryDraft,
  findLocalMemoryEntryDraftRange,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
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
    const parsed = parseLocalMemoryMarkdown(
      [
        '# Maka Memory',
        '',
        '## 偏好',
        '<!-- maka-memory: id=pref-1 origin=manual createdAt=1700000000000 -->',
        '喜欢简洁回答。',
        '',
        '## 手写条目',
        '没有 metadata 也要显示。',
      ].join('\n'),
    );
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
    const parsed = parseLocalMemoryMarkdown(
      [
        '# Maka Memory',
        '',
        '## Active preference',
        '<!-- maka-memory: id=pref-active origin=imported createdAt=1700000000000 updatedAt=1700000001000 status=active tags=work,AI,work decayTtlMs=86400000 unknownField=ok -->',
        'Keep answers concise.',
        '',
        '## Archived preference',
        '<!-- maka-memory: id=pref-old origin=extracted status=archived tags=old -->',
        'Do not use this anymore.',
      ].join('\n'),
    );

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
    const body = buildLocalMemoryPromptBody(
      [
        '# Maka Memory',
        '',
        '## Keep',
        '<!-- maka-memory: id=keep origin=manual status=active tags=style -->',
        'Prefer direct answers.',
        '',
        '## Archived',
        '<!-- maka-memory: id=old origin=manual status=archived -->',
        'This should not enter the model context.',
      ].join('\n'),
    );

    assert.ok(body);
    assert.match(body, /## Keep/);
    assert.match(body, /Tags: style/);
    assert.match(body, /Prefer direct answers/);
    assert.doesNotMatch(body, /maka-memory|Archived|should not enter/);
  });

  it('excludes pending, rejected, and unknown statuses from prompt injection', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Active',
      '<!-- maka-memory: id=active origin=manual status=active -->',
      'Use this.',
      '',
      '## Pending',
      '<!-- maka-memory: id=pending proposalId=proposal-abc source=chat_extracted status=review_required -->',
      'Do not inject pending.',
      '',
      '## Rejected',
      '<!-- maka-memory: id=rejected proposalId=proposal-def source=chat_extracted status=rejected -->',
      'Do not inject rejected.',
      '',
      '## Future',
      '<!-- maka-memory: id=future status=future_status -->',
      'Do not inject unknown future status.',
    ].join('\n');

    const parsed = parseLocalMemoryMarkdown(source);
    const body = buildLocalMemoryPromptBody(source);

    assert.equal(parsed.entries.length, 4);
    assert.equal(parsed.activeEntries.length, 1);
    assert.equal(parsed.entries.find((entry) => entry.id === 'future')?.status, 'unknown');
    assert.match(body ?? '', /Use this/);
    assert.doesNotMatch(body ?? '', /pending|rejected|unknown future/i);
  });

  it('redacts legacy secrets before building the prompt body', () => {
    const body = buildLocalMemoryPromptBody(
      [
        '# Maka Memory',
        '',
        '## Legacy pasted credential',
        '<!-- maka-memory: id=legacy-secret origin=manual status=active -->',
        'Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl0mn1opq',
        'Endpoint: https://api.example.test/models?api_key=raw-secret-value&timeout=30',
      ].join('\n'),
    );

    assert.ok(body);
    assert.doesNotMatch(body, /sk-ant-api03|raw-secret-value/);
    assert.match(body, /Authorization: Bearer \[redacted\]/);
    assert.match(body, /api_key=\[redacted\]/);
  });

  it('does not apply UI preview truncation to the prompt body', () => {
    const longPreference = `${'a'.repeat(520)}tail-marker`;
    const body = buildLocalMemoryPromptBody(
      [
        '# Maka Memory',
        '',
        '## Long preference',
        '<!-- maka-memory: id=long origin=manual status=active -->',
        longPreference,
      ].join('\n'),
    );

    assert.ok(body);
    assert.match(body, /tail-marker/);
  });

  it('appends a manual entry draft with visible metadata and preserves existing content', () => {
    const stableId = stableLocalMemoryEntryId('Prefer concise answers.', 1700000000000);
    const result = appendManualLocalMemoryEntryDraft('# Maka Memory\n', {
      title: '  Writing style  ',
      content: 'Prefer concise answers.',
      tags: [' preference ', 'writing style', 'preference', ''],
      now: 1700000000000,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.draft, /^# Maka Memory\n\n## Writing style/m);
    assert.equal(stableId, 'mem-eca1625ac35bd920');
    assert.match(
      result.draft,
      /id=mem-eca1625ac35bd920 origin=manual createdAt=1700000000000 status=active tags=preference,writing-style/,
    );
    assert.doesNotMatch(result.draft, /id=manual-1700000000000/);
    assert.match(result.draft, /Prefer concise answers\.\n$/);

    const parsed = parseLocalMemoryMarkdown(result.draft);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.activeEntries[0]?.id, stableId);
    assert.equal(parsed.activeEntries[0]?.origin, 'manual');
    assert.deepEqual(parsed.activeEntries[0]?.tags, ['preference', 'writing-style']);
  });

  it('creates pending proposals and keeps approval explicit', () => {
    const proposalId = stableLocalMemoryProposalId('Remember dark mode preference.', 1700000000000);
    const pending = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId,
      title: 'Theme preference',
      content: 'Remember dark mode preference.',
      proposedAt: 1700000000000,
      sourceTurnId: 'turn-1',
    });

    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    assert.equal(buildLocalMemoryPromptBody(pending.draft), undefined);
    const proposal = findLocalMemoryEntryDraft(pending.draft, proposalId);
    assert.equal(proposal?.status, 'review_required');
    assert.equal(proposal?.content, 'Remember dark mode preference.');

    const approved = approveLocalMemoryProposalDraft('# Maka Memory\n', pending.draft, {
      proposalId,
      entryId: 'mem-approved123',
      confirmedAt: 1700000001000,
      approvalSurface: 'settings_review_queue',
    });

    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.match(approved.memoryDraft, /id=mem-approved123/);
    assert.match(approved.memoryDraft, /source=chat_extracted/);
    assert.match(approved.memoryDraft, /confirmedAt=1700000001000/);
    assert.doesNotMatch(approved.pendingDraft, /proposal-approved123|Theme preference|dark mode/);
    assert.match(
      buildLocalMemoryPromptBody(approved.memoryDraft) ?? '',
      /Remember dark mode preference/,
    );
  });

  it('rejects pending proposals without creating active memory', () => {
    const pending = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId: 'proposal-reject123',
      title: 'Rejected proposal',
      content: 'Do not save this.',
      proposedAt: 1700000000000,
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const rejected = rejectLocalMemoryProposalDraft(pending.draft, {
      proposalId: 'proposal-reject123',
      rejectedAt: 1700000001000,
    });

    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    const parsed = parseLocalMemoryMarkdown(rejected.draft);
    assert.equal(parsed.entries[0]?.status, 'rejected');
    assert.equal(parsed.entries[0]?.rejectedAt, 1700000001000);
    assert.equal(buildLocalMemoryPromptBody(rejected.draft), undefined);
  });

  it('writes approved user-authored entries with confirmation metadata', () => {
    const approved = appendApprovedLocalMemoryEntryDraft('# Maka Memory\n', {
      id: 'mem-user123',
      title: 'Writing preference',
      content: 'Prefer concise answers.',
      source: 'user_authored',
      confirmedAt: 1700000000000,
      approvalSurface: 'manual_editor_save',
    });

    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    const parsed = parseLocalMemoryMarkdown(approved.draft);
    assert.equal(parsed.activeEntries[0]?.id, 'mem-user123');
    assert.equal(parsed.activeEntries[0]?.source, 'user_authored');
    assert.equal(parsed.activeEntries[0]?.confirmedAt, 1700000000000);
    assert.match(buildLocalMemoryPromptBody(approved.draft) ?? '', /Prefer concise answers/);
  });

  it('keeps manual entry ids stable across title edits', () => {
    const first = appendManualLocalMemoryEntryDraft('', {
      title: 'Writing style',
      content: 'Prefer concise answers.',
      now: 1700000000000,
    });
    const renamed = appendManualLocalMemoryEntryDraft('', {
      title: 'Updated writing style',
      content: 'Prefer concise answers.',
      now: 1700000000000,
    });

    assert.equal(first.ok, true);
    assert.equal(renamed.ok, true);
    if (!first.ok || !renamed.ok) return;
    const firstId = parseLocalMemoryMarkdown(first.draft).entries[0]?.id;
    const renamedId = parseLocalMemoryMarkdown(renamed.draft).entries[0]?.id;
    assert.equal(firstId, 'mem-eca1625ac35bd920');
    assert.equal(renamedId, firstId);
    assert.match(renamed.draft, /## Updated writing style/);
  });

  it('parses and updates legacy manual timestamp ids', () => {
    const legacy = [
      '# Maka Memory',
      '',
      '## Legacy preference',
      '<!-- maka-memory: id=manual-1700000000000 origin=manual createdAt=1700000000000 status=active -->',
      'Legacy content stays editable.',
    ].join('\n');

    const parsed = parseLocalMemoryMarkdown(legacy);
    assert.equal(parsed.entries[0]?.id, 'manual-1700000000000');

    const archived = setLocalMemoryEntryStatusDraft(legacy, {
      id: 'manual-1700000000000',
      status: 'archived',
      now: 1700000001000,
    });
    assert.equal(archived.ok, true);
    if (!archived.ok) return;
    assert.match(
      archived.draft,
      /id=manual-1700000000000 origin=manual createdAt=1700000000000 updatedAt=1700000001000 status=archived/,
    );
    assert.equal(
      parseLocalMemoryMarkdown(archived.draft).archivedEntries[0]?.id,
      'manual-1700000000000',
    );
  });

  it('archives and restores a memory entry by updating visible metadata', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Keep short',
      '<!-- maka-memory: id=keep origin=manual createdAt=1700000000000 status=active tags=style -->',
      'Prefer concise answers.',
    ].join('\n');

    const archived = setLocalMemoryEntryStatusDraft(source, {
      id: 'keep',
      status: 'archived',
      now: 1700000001000,
    });
    assert.equal(archived.ok, true);
    if (!archived.ok) return;
    assert.match(
      archived.draft,
      /id=keep origin=manual createdAt=1700000000000 updatedAt=1700000001000 status=archived tags=style/,
    );
    assert.equal(parseLocalMemoryMarkdown(archived.draft).archivedEntries[0]?.id, 'keep');
    assert.equal(buildLocalMemoryPromptBody(archived.draft), undefined);

    const restored = setLocalMemoryEntryStatusDraft(archived.draft, {
      id: 'keep',
      status: 'active',
      now: 1700000002000,
    });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(parseLocalMemoryMarkdown(restored.draft).activeEntries[0]?.id, 'keep');
    assert.match(buildLocalMemoryPromptBody(restored.draft) ?? '', /Prefer concise answers/);
  });

  it('locates a memory entry draft range by stable or legacy id', () => {
    const source = [
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual status=active -->',
      'First content.',
      '',
      '## Legacy Title',
      'Legacy content.',
      '',
      '## Last',
      '<!-- maka-memory: id=last origin=manual status=archived -->',
      'Last content.',
    ].join('\n');

    const first = findLocalMemoryEntryDraftRange(source, 'first');
    assert.ok(first);
    assert.equal(
      source.slice(first.start, first.end),
      [
        '## First',
        '<!-- maka-memory: id=first origin=manual status=active -->',
        'First content.',
        '',
        '',
      ].join('\n'),
    );

    const legacy = findLocalMemoryEntryDraftRange(source, 'legacy-title');
    assert.ok(legacy);
    assert.equal(
      source.slice(legacy.start, legacy.end),
      ['## Legacy Title', 'Legacy content.', '', ''].join('\n'),
    );

    const last = findLocalMemoryEntryDraftRange(source, 'last');
    assert.ok(last);
    assert.equal(
      source.slice(last.start, last.end),
      [
        '## Last',
        '<!-- maka-memory: id=last origin=manual status=archived -->',
        'Last content.',
      ].join('\n'),
    );
    assert.equal(findLocalMemoryEntryDraftRange(source, 'missing'), null);
  });

  it('can archive legacy entries without metadata by inserting a visible comment', () => {
    const result = setLocalMemoryEntryStatusDraft(
      ['# Maka Memory', '', '## 手写偏好', '旧格式内容。'].join('\n'),
      {
        id: '手写偏好',
        status: 'archived',
        now: 1700000000000,
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(
      result.draft,
      /## 手写偏好\n<!-- maka-memory: id=手写偏好 updatedAt=1700000000000 status=archived -->\n旧格式内容。/,
    );
    assert.equal(parseLocalMemoryMarkdown(result.draft).archivedEntries[0]?.id, '手写偏好');
  });

  it('rejects entry status updates for invalid or missing ids', () => {
    assert.deepEqual(setLocalMemoryEntryStatusDraft('', { id: ' ', status: 'active', now: 1 }), {
      ok: false,
      reason: 'invalid_id',
    });
    assert.deepEqual(
      setLocalMemoryEntryStatusDraft('## One\nBody', { id: 'missing', status: 'archived', now: 1 }),
      {
        ok: false,
        reason: 'not_found',
      },
    );
  });

  it('rejects blank manual draft entries and oversized resulting drafts', () => {
    assert.deepEqual(
      appendManualLocalMemoryEntryDraft('', { title: ' ', content: 'body', now: 1 }),
      {
        ok: false,
        reason: 'empty_title',
      },
    );
    assert.deepEqual(
      appendManualLocalMemoryEntryDraft('', { title: 'title', content: ' ', now: 1 }),
      {
        ok: false,
        reason: 'empty_content',
      },
    );
    const oversized = appendManualLocalMemoryEntryDraft('x'.repeat(LOCAL_MEMORY_MAX_BYTES), {
      title: 'title',
      content: 'body',
      now: 1,
    });
    assert.deepEqual(oversized, { ok: false, reason: 'oversize' });
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
    assert.equal(parsed.entries[0]?.id, 'mem-5de3e38c014ca2d7');
    assert.equal(parsed.entries[0]?.origin, 'manual');
  });
});
