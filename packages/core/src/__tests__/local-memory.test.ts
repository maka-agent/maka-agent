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
  deleteLocalMemoryEntryDraft,
  defaultLocalMemorySettings,
  findLocalMemoryEntryDraft,
  findLocalMemoryEntryDraftRange,
  normalizeLocalMemorySettings,
  parseLocalMemoryMarkdown,
  readLocalMemoryDocumentVersion,
  readLocalMemoryForAgent,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
  withLocalMemoryDocumentVersion,
} from '../local-memory.js';

describe('local MEMORY.md contract', () => {
  it('separates strict durable entries from legacy Markdown compatibility entries', () => {
    const parsed = parseLocalMemoryMarkdown([
      '# Maka Memory',
      '',
      '## Plain legacy',
      'plain legacy content',
      '',
      '## Old metadata',
      '<!-- maka-memory: id=old status=active scope=workspace -->',
      'old metadata content',
      '',
      '## Strict active',
      '<!-- maka-memory: id=strict entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required source=user_authored status=active scope=workspace confirmedAt=1700000000000 approvedBy=user approvalSurface=manual_editor_save sourceRefs=manual_editor:MEMORY.md -->',
      'strict content',
    ].join('\n'));

    assert.deepEqual(parsed.durableActiveEntries.map((entry) => entry.id), ['strict']);
    assert.deepEqual(parsed.compatibilityEntries.map((entry) => entry.id), ['plain-legacy', 'old']);
    assert.equal(parsed.entries[0]?.compatibilitySource, 'legacy_markdown');
    assert.equal(parsed.entries[0]?.migrationState, 'legacy_read_only');
    assert.equal(parsed.entries[0]?.approvalState, 'compatibility_unconfirmed');
    assert.equal(parsed.entries[0]?.status, 'review_required');
    assert.equal(parsed.entries[0]?.compatibilityStatus, 'legacy_active');
    assert.deepEqual(parsed.entries[0]?.sourceRefs.map((ref) => ref.kind), ['legacy_section']);
    assert.match(
      buildLocalMemoryPromptBody('## Plain legacy\nplain legacy content') ?? '',
      /legacy_markdown_read_only \(not confirmed structured memory\)/,
    );
    assert.equal(parsed.entries[2]?.compatibilitySource, 'structured_v1');
    assert.equal(parsed.entries[2]?.migrationState, 'not_required');
    assert.equal(parsed.entries[2]?.approvalState, 'confirmed');
    assert.deepEqual(parsed.entries[2]?.sourceRefs, [{ kind: 'manual_editor', ref: 'MEMORY.md' }]);
    assert.match(buildLocalMemoryPromptBody(parsedToMarkdownFixture(parsed.entries[2]!)) ?? '', /strict content/);
    assert.match(buildLocalMemoryPromptBody('## Legacy\nlegacy-only') ?? '', /legacy-only/);
  });

  it('keeps malformed versioned sections recoverable but never model-visible', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Missing evidence',
      '<!-- maka-memory: id=missing entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required source=user_authored status=active scope=workspace approvedBy=user approvalSurface=manual_editor_save -->',
      'recoverable body',
      '',
      '## Duplicate metadata',
      '<!-- maka-memory: id=duplicate entrySchema=maka.local_memory.entry.v1 -->',
      '<!-- maka-memory: status=active source=user_authored -->',
      'duplicate metadata body',
      '',
      '## Duplicate field',
      '<!-- maka-memory: id=duplicate-field entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required source=user_authored status=archived status=active scope=workspace confirmedAt=1700000000000 approvedBy=user approvalSurface=manual_editor_save sourceRefs=manual_editor:MEMORY.md -->',
      'duplicate field body',
    ].join('\n');
    const parsed = parseLocalMemoryMarkdown(source);

    assert.equal(parsed.safeMode, false);
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.durableActiveEntries.length, 0);
    assert.equal(parsed.malformedEntries.length, 3);
    assert.ok(parsed.malformedEntries.every((entry) => entry.migrationState === 'malformed_read_only'));
    assert.ok(parsed.malformedEntries.every((entry) => entry.status === 'unknown'));
    assert.match(parsed.entries[0]?.content ?? '', /recoverable body/);
    assert.match(parsed.entries[1]?.content ?? '', /duplicate metadata body/);
    assert.equal(buildLocalMemoryPromptBody(source), undefined);
  });

  it('rejects legacy-only or partially malformed source refs in structured entries', () => {
    for (const sourceRefs of [
      'legacy_section:old-digest',
      'manual_editor:MEMORY.md,bad-token',
      'manual_editor:MEMORY.md,manual_editor:MEMORY.md',
    ]) {
      const parsed = parseLocalMemoryMarkdown([
        '## Invalid refs',
        `<!-- maka-memory: id=invalid-refs entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required source=user_authored status=active scope=workspace confirmedAt=1700000000000 approvedBy=user approvalSurface=manual_editor_save sourceRefs=${sourceRefs} -->`,
        'must remain recoverable',
      ].join('\n'));
      assert.equal(parsed.durableActiveEntries.length, 0, sourceRefs);
      assert.equal(parsed.malformedEntries.length, 1, sourceRefs);
      assert.equal(parsed.entries[0]?.status, 'unknown', sourceRefs);
    }
  });

  it('requires confirmation metadata and source refs for every new strict active entry', () => {
    const approved = appendApprovedLocalMemoryEntryDraft('# Maka Memory\n', {
      id: 'mem-strict123',
      title: 'Strict entry',
      content: 'confirmed content',
      source: 'user_authored',
      confirmedAt: 1700000000000,
      approvalSurface: 'manual_editor_save',
    });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;

    assert.match(approved.draft, /entrySchema=maka\.local_memory\.entry\.v1/);
    assert.match(approved.draft, /sourceRefs=manual_editor:MEMORY\.md/);
    const parsed = parseLocalMemoryMarkdown(approved.draft);
    assert.deepEqual(parsed.durableActiveEntries.map((entry) => entry.id), ['mem-strict123']);

    const archived = setLocalMemoryEntryStatusDraft(approved.draft, {
      id: 'mem-strict123',
      status: 'archived',
      now: 1700000001000,
    });
    assert.equal(archived.ok, true);
    if (!archived.ok) return;
    const restored = setLocalMemoryEntryStatusDraft(archived.draft, {
      id: 'mem-strict123',
      status: 'active',
      now: 1700000002000,
    });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.deepEqual(parseLocalMemoryMarkdown(restored.draft).durableActiveEntries.map((entry) => entry.id), ['mem-strict123']);

    const legacyRestore = setLocalMemoryEntryStatusDraft(
      '## Legacy\n<!-- maka-memory: id=legacy status=archived -->\nlegacy body',
      { id: 'legacy', status: 'active', now: 1700000002000 },
    );
    assert.deepEqual(legacyRestore, { ok: false, reason: 'confirmation_required' });
  });

  it('makes compatibility reads explicit and rejects malformed entries', () => {
    const memory = [
      '## Legacy',
      'legacy-visible-only-in-compat',
      '',
      '## Strict',
      '<!-- maka-memory: id=strict entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required source=user_authored status=active scope=workspace confirmedAt=1700000000000 approvedBy=user approvalSurface=manual_editor_save sourceRefs=manual_editor:MEMORY.md -->',
      'strict-visible',
      '',
      '## Broken',
      '<!-- maka-memory: id=broken entrySchema=maka.local_memory.entry.v1 status=active -->',
      'broken-never-visible',
    ].join('\n');

    const compat = readLocalMemoryForAgent(memory, readContext());
    assert.equal(compat.status, 'visible');
    if (compat.status !== 'visible') return;
    assert.match(compat.promptBody, /legacy-visible-only-in-compat|strict-visible/);
    assert.doesNotMatch(compat.promptBody, /broken-never-visible/);
    assert.ok(compat.trace.decisions.some((item) => item.decision === 'selected_legacy_workspace_compat'));
    assert.ok(compat.trace.decisions.some((item) => item.decision === 'rejected_malformed_entry'));

    const strictOnly = readLocalMemoryForAgent(memory, { ...readContext(), legacyScopePolicy: 'deny' });
    assert.equal(strictOnly.status, 'visible');
    if (strictOnly.status === 'visible') {
      assert.doesNotMatch(strictOnly.promptBody, /legacy-visible-only-in-compat/);
      assert.match(strictOnly.promptBody, /strict-visible/);
    }
  });

  it('defaults file enabled but agent read disabled', () => {
    const settings = defaultLocalMemorySettings();
    assert.equal(settings.enabled, true);
    assert.equal(settings.agentReadEnabled, false);
  });

  it('reads legacy version zero and writes one canonical durable version marker', () => {
    const legacy = '# Maka Memory\n\n## Entry\nLegacy content.\n';
    assert.deepEqual(readLocalMemoryDocumentVersion(legacy), { ok: true, version: 0, legacy: true });

    const versioned = withLocalMemoryDocumentVersion(legacy, 7);
    assert.equal(versioned.ok, true);
    if (!versioned.ok) return;
    assert.equal(readLocalMemoryDocumentVersion(versioned.draft).version, 7);
    assert.equal((versioned.draft.match(/maka-memory-version:/g) ?? []).length, 1);

    const advanced = withLocalMemoryDocumentVersion(versioned.draft, 8);
    assert.equal(advanced.ok, true);
    if (advanced.ok) assert.equal(readLocalMemoryDocumentVersion(advanced.draft).version, 8);

    const literalContent = '## Note\nThe literal text maka-memory-version: is user content.\n';
    assert.deepEqual(readLocalMemoryDocumentVersion(literalContent), { ok: true, version: 0, legacy: true });
    const literalVersioned = withLocalMemoryDocumentVersion(literalContent, 1);
    assert.equal(literalVersioned.ok, true);
    if (literalVersioned.ok) assert.match(literalVersioned.draft, /literal text maka-memory-version: is user content/);
  });

  it('fails closed on malformed, duplicate, or unsafe durable version markers', () => {
    for (const input of [
      '<!-- maka-memory-version: nope -->\n# Maka Memory\n',
      '<!-- maka-memory-version: 1 -->\n<!-- maka-memory-version: 2 -->\n# Maka Memory\n',
      `<!-- maka-memory-version: ${Number.MAX_SAFE_INTEGER + 1} -->\n# Maka Memory\n`,
    ]) {
      assert.equal(readLocalMemoryDocumentVersion(input).ok, false);
    }
    assert.equal(withLocalMemoryDocumentVersion('# Maka Memory\n', -1).ok, false);
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

  it('enforces workspace, session, status, and legacy scope on model-visible reads', () => {
    const memory = [
      '# Maka Memory',
      '',
      '## Workspace',
      strictActiveMeta('workspace'),
      'workspace-visible',
      '',
      '## Session A',
      strictActiveMeta('session-a', 'scope=session sessionId=session-a'),
      'session-a-visible',
      '',
      '## Session B',
      strictActiveMeta('session-b', 'scope=session sessionId=session-b'),
      'session-b-private',
      '',
      '## Owner Missing',
      '<!-- maka-memory: id=session-missing status=active scope=session -->',
      'owner-missing-private',
      '',
      '## Archived',
      '<!-- maka-memory: id=archived status=archived scope=workspace -->',
      'archived-private',
      '',
      '## Legacy',
      '<!-- maka-memory: id=legacy status=active -->',
      'legacy-compatible',
    ].join('\n');
    const result = readLocalMemoryForAgent(memory, readContext());
    assert.equal(result.status, 'visible');
    if (result.status !== 'visible') return;
    assert.match(result.promptBody, /workspace-visible/);
    assert.match(result.promptBody, /session-a-visible/);
    assert.match(result.promptBody, /legacy-compatible/);
    assert.doesNotMatch(result.promptBody, /session-b-private|owner-missing-private|archived-private/);
    assert.deepEqual(result.trace.decisions.map((entry) => entry.decision), [
      'selected_workspace',
      'selected_session',
      'rejected_other_session',
      'rejected_session_owner_missing',
      'selected_legacy_workspace_compat',
    ]);
    assert.doesNotMatch(
      JSON.stringify(result.trace),
      /workspace-visible|session-a-visible|session-b-private|owner-missing-private|archived-private|legacy-compatible/,
    );

    const strictLegacy = readLocalMemoryForAgent(memory, { ...readContext(), legacyScopePolicy: 'deny' });
    assert.equal(strictLegacy.trace.decisions.at(-1)?.decision, 'rejected_legacy_scope');
  });

  it('returns typed empty reads before parsing when memory is disabled, private, or cross-workspace', () => {
    const cases = [
      [{ enabled: false }, 'disabled'],
      [{ agentReadEnabled: false }, 'agent_read_disabled'],
      [{ incognitoActive: true }, 'incognito_active'],
      [{ workspaceRoot: '/workspace/b' }, 'workspace_mismatch'],
    ] as const;
    for (const [patch, reason] of cases) {
      const result = readLocalMemoryForAgent('## Secret\nPRIVATE_TEST_SECRET', { ...readContext(), ...patch });
      assert.equal(result.status, 'empty');
      if (result.status === 'empty') assert.equal(result.reason, reason);
      assert.equal(result.trace.totalActiveEntries, 0);
      assert.doesNotMatch(JSON.stringify(result.trace), /PRIVATE_TEST_SECRET/);
    }
  });

  it('uses current metadata as visibility authority without refreshing snapshotted content', () => {
    const snapshot = [
      '# Maka Memory',
      '',
      '## Kept content',
      '<!-- maka-memory: id=kept status=active scope=workspace -->',
      'Original content.',
      '',
      '## Archived later',
      '<!-- maka-memory: id=archived status=active scope=workspace -->',
      'Must disappear.',
    ].join('\n');
    const current = [
      '# Maka Memory',
      '',
      '## Kept content',
      '<!-- maka-memory: id=kept status=active scope=workspace -->',
      'Edited after backend creation.',
      '',
      '## Archived later',
      '<!-- maka-memory: id=archived status=archived scope=workspace -->',
      'Must disappear.',
    ].join('\n');

    const read = readLocalMemoryForAgent(snapshot, readContext(), current);
    assert.equal(read.status, 'visible');
    if (read.status !== 'visible') return;
    assert.match(read.promptBody, /Original content/);
    assert.doesNotMatch(read.promptBody, /Edited after backend creation|Must disappear/);
    assert.ok(read.trace.decisions.some((item) => item.decision === 'rejected_not_current_or_active'));
  });

  it('fails closed on duplicate ids instead of sharing one authority decision across entries', () => {
    const duplicateIds = [
      '# Maka Memory',
      '',
      '## Session A',
      '<!-- maka-memory: id=duplicate status=active scope=session sessionId=session-a -->',
      'session-a-private',
      '',
      '## Session B',
      '<!-- maka-memory: id=duplicate status=active scope=session sessionId=session-b -->',
      'session-b-private',
    ].join('\n');

    for (const sessionId of ['session-a', 'session-b']) {
      const read = readLocalMemoryForAgent(duplicateIds, { ...readContext(), sessionId });
      assert.equal(read.status, 'empty');
      if (read.status === 'empty') assert.equal(read.reason, 'ambiguous_entry_ids');
      assert.doesNotMatch(JSON.stringify(read.trace), /session-a-private|session-b-private/);
    }
  });

  it('uses current scope ownership when a snapshotted entry changes sessions', () => {
    const snapshot = [
      '## Private',
      '<!-- maka-memory: id=private status=active scope=session sessionId=session-a -->',
      'private-content',
    ].join('\n');
    const current = [
      '## Private',
      '<!-- maka-memory: id=private status=active scope=session sessionId=session-b -->',
      'private-content',
    ].join('\n');

    const sessionA = readLocalMemoryForAgent(snapshot, readContext(), current);
    const sessionB = readLocalMemoryForAgent(snapshot, { ...readContext(), sessionId: 'session-b' }, current);
    assert.equal(sessionA.status, 'empty');
    assert.equal(sessionB.status, 'visible');
    if (sessionB.status === 'visible') assert.match(sessionB.promptBody, /private-content/);
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
    assert.equal(parsed.activeEntries.length, 0);
    assert.equal(parsed.compatibilityEntries.length, 2);
    assert.equal(parsed.archivedEntries.length, 0);
    assert.equal(parsed.entries[0]?.id, 'pref-1');
    assert.equal(parsed.entries[0]?.origin, 'manual');
    assert.equal(parsed.entries[0]?.status, 'review_required');
    assert.equal(parsed.entries[0]?.compatibilityStatus, 'legacy_active');
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
    assert.equal(parsed.activeEntries.length, 0);
    assert.equal(parsed.archivedEntries.length, 0);
    assert.equal(parsed.compatibilityEntries.length, 2);
    assert.equal(parsed.entries[0]?.origin, 'imported');
    assert.equal(parsed.entries[0]?.status, 'review_required');
    assert.equal(parsed.entries[0]?.updatedAt, 1700000001000);
    assert.deepEqual(parsed.entries[0]?.tags, ['work', 'ai']);
    assert.equal(parsed.entries[0]?.decayTtlMs, 86400000);
    assert.equal(parsed.entries[1]?.origin, 'extracted');
    assert.equal(parsed.entries[1]?.status, 'archived');
  });

  it('builds prompt body from active entries only and omits metadata comments', () => {
    const body = buildLocalMemoryPromptBody([
      '# Maka Memory',
      '',
      '## Keep',
      strictActiveMeta('keep', 'tags=style'),
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

  it('excludes pending, rejected, and unknown statuses from prompt injection', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Active',
      strictActiveMeta('active'),
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

  it('redacts legacy secrets before compatibility prompt rendering', () => {
    const read = readLocalMemoryForAgent([
      '# Maka Memory',
      '',
      '## Legacy pasted credential',
      '<!-- maka-memory: id=legacy-secret origin=manual status=active -->',
      'Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl0mn1opq',
      'Endpoint: https://api.example.test/models?api_key=raw-secret-value&timeout=30',
    ].join('\n'), readContext());

    assert.equal(read.status, 'visible');
    if (read.status !== 'visible') return;
    const body = read.promptBody;
    assert.doesNotMatch(body, /sk-ant-api03|raw-secret-value/);
    assert.match(body, /Authorization: Bearer \[redacted\]/);
    assert.match(body, /api_key=\[redacted\]/);
  });

  it('does not apply UI preview truncation to the prompt body', () => {
    const longPreference = `${'a'.repeat(520)}tail-marker`;
    const body = buildLocalMemoryPromptBody([
      '# Maka Memory',
      '',
      '## Long preference',
      strictActiveMeta('long'),
      longPreference,
    ].join('\n'));

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
      /id=mem-eca1625ac35bd920 .*origin=manual source=user_authored .*confirmedAt=1700000000000 status=active .*sourceRefs=manual_editor:MEMORY\.md tags=preference,writing-style/,
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
    assert.match(buildLocalMemoryPromptBody(approved.memoryDraft) ?? '', /Remember dark mode preference/);
  });

  it('requires a session owner and preserves it through proposal approval', () => {
    const missingApprovedOwner = appendApprovedLocalMemoryEntryDraft('# Maka Memory\n', {
      id: 'mem-session-missing',
      title: 'Session memory',
      content: 'private session content',
      source: 'user_authored',
      scope: 'session',
      confirmedAt: 1700000000000,
    });
    assert.deepEqual(missingApprovedOwner, { ok: false, reason: 'session_owner_required' });

    const missingProposalOwner = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId: 'proposal-session-missing',
      title: 'Session proposal',
      content: 'private proposal content',
      scope: 'session',
      proposedAt: 1700000000000,
    });
    assert.deepEqual(missingProposalOwner, { ok: false, reason: 'session_owner_required' });

    const pending = appendLocalMemoryProposalDraft('# Maka Pending Memory\n', {
      proposalId: 'proposal-session-owned',
      title: 'Owned session proposal',
      content: 'session-a-only',
      scope: 'session',
      sessionId: 'session-a',
      proposedAt: 1700000000000,
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    assert.equal(findLocalMemoryEntryDraft(pending.draft, 'proposal-session-owned')?.sessionId, 'session-a');

    const approved = approveLocalMemoryProposalDraft('# Maka Memory\n', pending.draft, {
      proposalId: 'proposal-session-owned',
      entryId: 'mem-session-owned',
      confirmedAt: 1700000001000,
    });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.entry.scope, 'session');
    assert.equal(approved.entry.sessionId, 'session-a');
    assert.match(approved.memoryDraft, /scope=session sessionId=session-a/);
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
    assert.match(archived.draft, /id=manual-1700000000000 origin=manual createdAt=1700000000000 updatedAt=1700000001000 status=archived/);
    assert.equal(parseLocalMemoryMarkdown(archived.draft).compatibilityEntries[0]?.id, 'manual-1700000000000');
  });

  it('archives and restores a memory entry by updating visible metadata', () => {
    const source = [
      '# Maka Memory',
      '',
      '## Keep short',
      strictActiveMeta('keep', 'createdAt=1700000000000 tags=style'),
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
      /id=keep .*createdAt=1700000000000 updatedAt=1700000001000 .*status=archived .*tags=style/,
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

  it('deletes one memory entry without disturbing the surrounding document', () => {
    const input = [
      '# Maka Memory',
      '',
      '## Keep',
      '<!-- maka-memory: id=keep status=active scope=workspace -->',
      'keep-content',
      '',
      '## Delete',
      '<!-- maka-memory: id=delete status=active scope=workspace -->',
      'delete-content',
    ].join('\n');
    const deleted = deleteLocalMemoryEntryDraft(input, 'delete');
    assert.equal(deleted.ok, true);
    if (!deleted.ok) return;
    assert.match(deleted.draft, /keep-content/);
    assert.doesNotMatch(deleted.draft, /delete-content/);
    assert.equal(deleteLocalMemoryEntryDraft(input, 'missing').ok, false);
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
    assert.equal(source.slice(first.start, first.end), [
      '## First',
      '<!-- maka-memory: id=first origin=manual status=active -->',
      'First content.',
      '',
      '',
    ].join('\n'));

    const legacy = findLocalMemoryEntryDraftRange(source, 'legacy-title');
    assert.ok(legacy);
    assert.equal(source.slice(legacy.start, legacy.end), [
      '## Legacy Title',
      'Legacy content.',
      '',
      '',
    ].join('\n'));

    const last = findLocalMemoryEntryDraftRange(source, 'last');
    assert.ok(last);
    assert.equal(source.slice(last.start, last.end), [
      '## Last',
      '<!-- maka-memory: id=last origin=manual status=archived -->',
      'Last content.',
    ].join('\n'));
    assert.equal(findLocalMemoryEntryDraftRange(source, 'missing'), null);
  });

  it('can archive legacy entries without metadata by inserting a visible comment', () => {
    const result = setLocalMemoryEntryStatusDraft([
      '# Maka Memory',
      '',
      '## 手写偏好',
      '旧格式内容。',
    ].join('\n'), {
      id: '手写偏好',
      status: 'archived',
      now: 1700000000000,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.draft, /## 手写偏好\n<!-- maka-memory: id=手写偏好 updatedAt=1700000000000 status=archived -->\n旧格式内容。/);
    assert.equal(parseLocalMemoryMarkdown(result.draft).compatibilityEntries[0]?.id, '手写偏好');
  });

  it('rejects entry status updates for invalid or missing ids', () => {
    assert.deepEqual(setLocalMemoryEntryStatusDraft('', { id: ' ', status: 'active', now: 1 }), {
      ok: false,
      reason: 'invalid_id',
    });
    assert.deepEqual(setLocalMemoryEntryStatusDraft('## One\nBody', { id: 'missing', status: 'archived', now: 1 }), {
      ok: false,
      reason: 'not_found',
    });
  });

  it('rejects blank manual draft entries and oversized resulting drafts', () => {
    assert.deepEqual(appendManualLocalMemoryEntryDraft('', { title: ' ', content: 'body', now: 1 }), {
      ok: false,
      reason: 'empty_title',
    });
    assert.deepEqual(appendManualLocalMemoryEntryDraft('', { title: 'title', content: ' ', now: 1 }), {
      ok: false,
      reason: 'empty_content',
    });
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

function strictActiveMeta(id: string, extra = ''): string {
  const scope = /(?:^|\s)scope=/.test(extra) ? '' : ' scope=workspace';
  return `<!-- maka-memory: id=${id} entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required origin=manual source=user_authored status=active${scope} confirmedAt=1700000000000 approvedBy=user approvalSurface=manual_editor_save sourceRefs=manual_editor:MEMORY.md${extra ? ` ${extra}` : ''} -->`;
}

function parsedToMarkdownFixture(entry: { title: string; content: string }): string {
  return [
    `## ${entry.title}`,
    '<!-- maka-memory: id=strict entrySchema=maka.local_memory.entry.v1 compatSource=structured_v1 migrationState=not_required source=user_authored status=active scope=workspace confirmedAt=1700000000000 approvedBy=user approvalSurface=manual_editor_save sourceRefs=manual_editor:MEMORY.md -->',
    entry.content,
  ].join('\n');
}

function readContext() {
  return {
    workspaceRoot: '/workspace/a',
    sourceWorkspaceRoot: '/workspace/a',
    sessionId: 'session-a',
    enabled: true,
    agentReadEnabled: true,
    incognitoActive: false,
  } as const;
}
