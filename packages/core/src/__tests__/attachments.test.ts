import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { attachmentKindFromMimeType, guessMimeFromName } from '../index.js';

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

  test('guessMimeFromName maps common extensions and falls back to octet-stream', () => {
    assert.equal(guessMimeFromName('chart.png'), 'image/png');
    assert.equal(guessMimeFromName('photo.JPG'), 'image/jpeg');
    assert.equal(guessMimeFromName('anim.gif'), 'image/gif');
    assert.equal(guessMimeFromName('shot.webp'), 'image/webp');
    assert.equal(guessMimeFromName('doc.pdf'), 'application/pdf');
    assert.equal(guessMimeFromName('sheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(guessMimeFromName('unknown.xyz'), 'application/octet-stream');
    assert.equal(guessMimeFromName('noext'), 'application/octet-stream');
  });
});
