import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { attachmentKindFromMimeType } from '../index.js';

describe('attachment MIME routing', () => {
  test('classifies image MIME types as image', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      assert.equal(attachmentKindFromMimeType(mime), 'image', `${mime} should route to image`);
    }
  });

  test('classifies application/pdf as pdf', () => {
    assert.equal(attachmentKindFromMimeType('application/pdf'), 'pdf');
  });

  test('classifies office file extensions as doc regardless of MIME', () => {
    assert.equal(
      attachmentKindFromMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'),
      'doc',
    );
    assert.equal(attachmentKindFromMimeType('application/octet-stream', 'budget.xlsx'), 'doc');
    assert.equal(attachmentKindFromMimeType('', 'slides.pptx'), 'doc');
  });
});
