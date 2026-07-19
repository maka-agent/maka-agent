import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  ansi,
  disc,
  stripAnsi,
  _setColorLevelForTesting,
  _detectColorLevelForTesting as detect,
} from '../tui-ansi.js';

// Reset to truecolor (the development default) after each test so a test that
// changes the level never leaks into the next one.
afterEach(() => _setColorLevelForTesting(3));

describe('tui-ansi semantic slots (#1053)', () => {
  test('muted is a truecolor cool-grey slot', () => {
    _setColorLevelForTesting(3);
    assert.equal(ansi.muted('x'), '\x1b[38;2;128;132;140mx\x1b[39m');
  });
});

describe('disc (#1053)', () => {
  test('renders a single ● glyph regardless of tone', () => {
    _setColorLevelForTesting(3);
    for (const tone of ['ok', 'muted', 'accent', 'danger'] as const) {
      assert.equal(stripAnsi(disc(tone)), '●', `tone ${tone} should yield one ●`);
    }
  });

  test('done (ok) disc uses standard green', () => {
    _setColorLevelForTesting(3);
    assert.equal(disc('ok'), '\x1b[32m●\x1b[39m');
  });

  test('detached/unavailable (muted) disc uses the muted cool-grey', () => {
    _setColorLevelForTesting(3);
    assert.equal(disc('muted'), '\x1b[38;2;128;132;140m●\x1b[39m');
  });

  test('running (accent) disc uses the logo blue', () => {
    _setColorLevelForTesting(3);
    assert.equal(disc('accent'), '\x1b[38;2;87;163;239m●\x1b[39m');
  });

  test('error (danger) disc uses standard red', () => {
    _setColorLevelForTesting(3);
    assert.equal(disc('danger'), '\x1b[31m●\x1b[39m');
  });
});

describe('color capability fallback (#1064)', () => {
  test('level 3 (truecolor) emits 24-bit RGB escapes', () => {
    _setColorLevelForTesting(3);
    assert.equal(ansi.accent('x'), '\x1b[38;2;87;163;239mx\x1b[39m');
    assert.equal(ansi.muted('x'), '\x1b[38;2;128;132;140mx\x1b[39m');
  });

  test('level 2 (256-color) downgrades to nearest 256-color palette entry', () => {
    _setColorLevelForTesting(2);
    // Logo blue [87, 163, 239] → cube: r=1(95), g=3(175), b=5(255)
    // → 16 + 1*36 + 3*6 + 5 = 16 + 36 + 18 + 5 = 75
    assert.equal(ansi.accent('x'), '\x1b[38;5;75mx\x1b[39m');
    // Muted grey [128, 132, 140] → cube: r=2(135), g=2(135), b=2(135)
    // → 16 + 2*36 + 2*6 + 2 = 16 + 72 + 12 + 2 = 102
    assert.equal(ansi.muted('x'), '\x1b[38;5;102mx\x1b[39m');
  });

  test('level 1 (16-color) downgrades to nearest ANSI 16-color entry', () => {
    _setColorLevelForTesting(1);
    // Logo blue [87, 163, 239] → nearest is white (7) → code 37
    assert.equal(ansi.accent('x'), '\x1b[37mx\x1b[39m');
    // Muted grey [128, 132, 140] → nearest is bright black/grey (8) → code 90
    assert.equal(ansi.muted('x'), '\x1b[90mx\x1b[39m');
  });

  test('level 0 (no color) strips all color escapes', () => {
    _setColorLevelForTesting(0);
    assert.equal(ansi.accent('x'), 'x');
    assert.equal(ansi.muted('x'), 'x');
    assert.equal(ansi.bold('x'), 'x');
    assert.equal(ansi.red('x'), 'x');
    assert.equal(disc('ok'), '●');
    assert.equal(disc('muted'), '●');
    assert.equal(disc('accent'), '●');
    assert.equal(disc('danger'), '●');
  });

  test('basic style codes (bold, dim, red) still work at level 1', () => {
    _setColorLevelForTesting(1);
    assert.equal(ansi.bold('x'), '\x1b[1mx\x1b[22m');
    assert.equal(ansi.dim('x'), '\x1b[2mx\x1b[22m');
    assert.equal(ansi.red('x'), '\x1b[31mx\x1b[39m');
  });

  test('basic style codes are stripped at level 0', () => {
    _setColorLevelForTesting(0);
    assert.equal(ansi.bold('x'), 'x');
    assert.equal(ansi.dim('x'), 'x');
    assert.equal(ansi.yellow('x'), 'x');
  });
});

describe('detectColorLevel env detection (#1064)', () => {
  test('NO_COLOR with non-empty value → level 0', () => {
    assert.equal(detect({ NO_COLOR: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 0);
    assert.equal(detect({ NO_COLOR: '0', TERM: 'xterm-256color' }), 0);
  });

  test('NO_COLOR with empty string → color still enabled (per spec)', () => {
    assert.equal(detect({ NO_COLOR: '', TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 3);
  });

  test('NO_COLOR unset → color enabled', () => {
    assert.equal(detect({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 3);
  });

  test('TERM=dumb → level 0', () => {
    assert.equal(detect({ TERM: 'dumb' }), 0);
  });

  test('TERM unset/empty → level 0', () => {
    assert.equal(detect({}), 0);
    assert.equal(detect({ TERM: '' }), 0);
  });

  test('COLORTERM=truecolor → level 3', () => {
    assert.equal(detect({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 3);
    assert.equal(detect({ TERM: 'xterm', COLORTERM: '24bit' }), 3);
  });

  test('TERM ending with -truecolor → level 3', () => {
    assert.equal(detect({ TERM: 'xterm-truecolor' }), 3);
    assert.equal(detect({ TERM: 'tmux-24bit' }), 3);
  });

  test('TERM with 256color (no COLORTERM) → level 2', () => {
    assert.equal(detect({ TERM: 'xterm-256color' }), 2);
    assert.equal(detect({ TERM: 'screen-256color' }), 2);
  });

  test('TERM with 256color + COLORTERM=truecolor → level 3 (COLORTERM wins)', () => {
    assert.equal(detect({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }), 3);
  });

  test('Generic TERM (xterm, screen, rxvt) → level 1', () => {
    assert.equal(detect({ TERM: 'xterm' }), 1);
    assert.equal(detect({ TERM: 'screen' }), 1);
    assert.equal(detect({ TERM: 'rxvt-unicode' }), 1);
  });
});
