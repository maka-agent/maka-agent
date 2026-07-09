import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';

describe('attachment approval registry (approvalId-based)', () => {
  it('issues opaque approval ids that never expose the path to the renderer', () => {
    const approvals = createAttachmentApprovalRegistry();
    const issued = approvals.issueApprovals(1, [
      { path: '/tmp/report.png', name: 'report.png', mimeType: 'image/png', size: 1024 },
    ]);
    assert.equal(issued.length, 1);
    assert.ok(issued[0].approvalId);
    assert.equal('path' in issued[0], false);
    assert.equal(issued[0].name, 'report.png');
    assert.equal(issued[0].mimeType, 'image/png');
    assert.equal(issued[0].size, 1024);
  });

  it('consumes an approval only once for the issuing sender', () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [
      { path: '/tmp/a.txt', name: 'a.txt', size: 10 },
    ]);
    assert.deepEqual(approvals.consumeApproval(1, issued.approvalId), {
      path: resolve('/tmp/a.txt'),
      name: 'a.txt',
      size: 10,
    });
    // one-shot: a second consume is rejected
    assert.equal(approvals.consumeApproval(1, issued.approvalId), null);
  });

  it('rejects an approval from a different sender without consuming it', () => {
    const approvals = createAttachmentApprovalRegistry();
    const [issued] = approvals.issueApprovals(1, [
      { path: '/tmp/a.txt', name: 'a.txt', size: 10 },
    ]);
    assert.equal(approvals.consumeApproval(2, issued.approvalId), null);
    // the rightful sender can still consume it
    assert.ok(approvals.consumeApproval(1, issued.approvalId));
  });

  it('expires unconsumed approvals by TTL', () => {
    let now = 1_000;
    const approvals = createAttachmentApprovalRegistry({ now: () => now, ttlMs: 500 });
    const [issued] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a.txt', size: 10 }]);
    now += 501;
    assert.equal(approvals.consumeApproval(1, issued.approvalId), null);
  });

  it('caps approvals by evicting the oldest entry first', () => {
    let now = 1_000;
    const approvals = createAttachmentApprovalRegistry({ now: () => now, maxEntries: 2 });
    const [a] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a', size: 1 }]);
    now += 1;
    approvals.issueApprovals(1, [{ path: '/tmp/b.txt', name: 'b', size: 1 }]);
    now += 1;
    approvals.issueApprovals(1, [{ path: '/tmp/c.txt', name: 'c', size: 1 }]);
    assert.equal(approvals.size(), 2);
    assert.equal(approvals.consumeApproval(1, a.approvalId), null);
  });

  it('clears only the named sender on clearSender', () => {
    const approvals = createAttachmentApprovalRegistry();
    const [a] = approvals.issueApprovals(1, [{ path: '/tmp/a.txt', name: 'a', size: 1 }]);
    const [b] = approvals.issueApprovals(2, [{ path: '/tmp/b.txt', name: 'b', size: 1 }]);
    approvals.clearSender(1);
    assert.equal(approvals.consumeApproval(1, a.approvalId), null);
    assert.ok(approvals.consumeApproval(2, b.approvalId));
  });
});
