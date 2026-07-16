import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ansi, disc, stripAnsi } from '../tui-ansi.js';

describe('tui-ansi semantic slots (#1053)', () => {
  test('muted is a truecolor cool-grey slot', () => {
    assert.equal(ansi.muted('x'), '\x1b[38;2;128;132;140mx\x1b[39m');
  });
});

describe('disc (#1053)', () => {
  test('renders a single ● glyph regardless of tone', () => {
    for (const tone of ['muted', 'accent', 'danger'] as const) {
      assert.equal(stripAnsi(disc(tone)), '●', `tone ${tone} should yield one ●`);
    }
  });

  test('done (muted) disc uses the muted cool-grey', () => {
    assert.equal(disc('muted'), '\x1b[38;2;128;132;140m●\x1b[39m');
  });

  test('running (accent) disc uses the logo blue', () => {
    assert.equal(disc('accent'), '\x1b[38;2;87;163;239m●\x1b[39m');
  });

  test('error (danger) disc uses standard red', () => {
    assert.equal(disc('danger'), '\x1b[31m●\x1b[39m');
  });
});
