import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  createAttachmentApprovalRegistry,
  normalizeExternalAttachmentPath,
  validateRendererAttachments,
} from '../attachment-approval.js';

describe('attachment path approval registry', () => {
  it('approves external paths per renderer sender and expires them by TTL', () => {
    let now = 1_000;
    const approvals = createAttachmentApprovalRegistry({
      now: () => now,
      ttlMs: 500,
    });
    const path = resolve('/tmp/report.png');

    approvals.approvePaths(1, path);
    assert.equal(approvals.isApproved(1, path), true);
    assert.equal(approvals.isApproved(2, path), false);

    now += 501;
    assert.equal(approvals.isApproved(1, path), false);
  });

  it('caps approvals by removing the oldest entries first', () => {
    let now = 1_000;
    const approvals = createAttachmentApprovalRegistry({
      now: () => now,
      maxEntries: 2,
    });

    approvals.approvePaths(1, '/tmp/a.txt');
    now += 1;
    approvals.approvePaths(1, '/tmp/b.txt');
    now += 1;
    approvals.approvePaths(1, '/tmp/c.txt');

    assert.equal(approvals.size(), 2);
    assert.equal(approvals.isApproved(1, '/tmp/a.txt'), false);
    assert.equal(approvals.isApproved(1, '/tmp/b.txt'), true);
    assert.equal(approvals.isApproved(1, '/tmp/c.txt'), true);
  });

  it('normalizes external paths without accepting empty or nul-containing values', () => {
    assert.equal(normalizeExternalAttachmentPath('/tmp/report.png'), resolve('/tmp/report.png'));
    assert.equal(normalizeExternalAttachmentPath(''), null);
    assert.equal(normalizeExternalAttachmentPath('/tmp/a\0b'), null);
    assert.equal(normalizeExternalAttachmentPath(null), null);
  });
});

describe('renderer attachment validation', () => {
  it('rejects unapproved external file refs before they reach runtime or storage', () => {
    const approvals = createAttachmentApprovalRegistry();
    const result = validateRendererAttachments([
      attachment({
        ref: { kind: 'external_file', absolutePath: '/private/tmp/secret.png' },
      }),
    ], { senderId: 1, approvals });

    assert.deepEqual(result, { ok: false, reason: 'unapproved_external_path' });
  });

  it('accepts approved external file refs only for the sender that chose the file', () => {
    const approvals = createAttachmentApprovalRegistry();
    approvals.approvePaths(1, '/private/tmp/report.png');

    const approved = validateRendererAttachments([
      attachment({
        ref: { kind: 'external_file', absolutePath: '/private/tmp/report.png' },
      }),
    ], { senderId: 1, approvals });
    const otherSender = validateRendererAttachments([
      attachment({
        ref: { kind: 'external_file', absolutePath: '/private/tmp/report.png' },
      }),
    ], { senderId: 2, approvals });

    assert.equal(approved.ok, true);
    if (approved.ok) {
      assert.equal(approved.attachments?.[0]?.ref.kind, 'external_file');
      assert.equal(
        approved.attachments?.[0]?.ref.kind === 'external_file'
          ? approved.attachments[0].ref.absolutePath
          : '',
        resolve('/private/tmp/report.png'),
      );
    }
    assert.deepEqual(otherSender, { ok: false, reason: 'unapproved_external_path' });
  });

  it('accepts safe session/workspace relative refs and rejects path escapes', () => {
    const approvals = createAttachmentApprovalRegistry();
    const valid = validateRendererAttachments([
      attachment({
        ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'uploads/report.png' },
      }),
      attachment({
        ref: { kind: 'workspace_file', relativePath: 'notes/context.md' },
      }),
    ], { senderId: 1, approvals });
    const traversal = validateRendererAttachments([
      attachment({
        ref: { kind: 'workspace_file', relativePath: '../secret.md' },
      }),
    ], { senderId: 1, approvals });
    const absolute = validateRendererAttachments([
      attachment({
        ref: { kind: 'session_file', sessionId: 'session-1', relativePath: join('/tmp', 'secret.md') },
      }),
    ], { senderId: 1, approvals });

    assert.equal(valid.ok, true);
    assert.deepEqual(traversal, { ok: false, reason: 'invalid_attachment' });
    assert.deepEqual(absolute, { ok: false, reason: 'invalid_attachment' });
  });

  it('rejects malformed and excessive renderer attachment arrays', () => {
    const approvals = createAttachmentApprovalRegistry();
    assert.deepEqual(validateRendererAttachments('not-array', { senderId: 1, approvals }), {
      ok: false,
      reason: 'invalid_attachment',
    });
    assert.deepEqual(
      validateRendererAttachments(Array.from({ length: 9 }, () => attachment()), { senderId: 1, approvals }),
      { ok: false, reason: 'too_many_attachments' },
    );
    assert.deepEqual(
      validateRendererAttachments([attachment({ bytes: 51 * 1024 * 1024 })], { senderId: 1, approvals }),
      { ok: false, reason: 'invalid_attachment' },
    );
  });

  it('wires sessions:send through the attachment approval gate', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/main.ts'), 'utf8');

    assert.match(source, /const attachmentApprovals = createAttachmentApprovalRegistry\(\)/);
    assert.match(source, /validateRendererAttachments\(command\.attachments/);
    assert.match(source, /senderId: event\.sender\.id/);
    assert.match(source, /attachments: attachments\.attachments/);
    assert.doesNotMatch(source, /attachments: command\.attachments/);
  });
});

function attachment(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'image',
    name: 'report.png',
    mimeType: 'image/png',
    bytes: 1024,
    ref: { kind: 'workspace_file', relativePath: 'uploads/report.png' },
    ...patch,
  };
}
