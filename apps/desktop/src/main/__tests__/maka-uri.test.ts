/**
 * Tests for the PR-UI-RENDER-2 internal-URI parser.
 *
 * The renderer's `<a>` override calls `parseMakaUri(href)` exactly
 * once and branches on a discriminated union or `null`. We lock the
 * parser's narrow contract here so a future "let's also allow
 * `maka://tool/...`" change can't sneak past silently.
 *
 * @kenji review gates (msg 1e9a9d96 + msg 4d41ba39) addressed:
 *   - scheme is exact `maka:` (no `Maka:` / `MAKA:` etc.)
 *   - settings section must be a real `SettingsSection` member
 *   - host-based dispatch (not pathname-segment-0 dispatch)
 *   - compose.text length-capped, empty-text rejected, raw href
 *     length-capped before URL constructor
 *   - unsupported namespace → null (renderer renders broken-link
 *     inline error, NOT external-link fallback)
 *   - no userinfo / port / fragment leakage
 *
 * Imported via `@maka/ui/maka-uri` subpath so node:test doesn't load
 * the React barrel.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SETTINGS_SECTIONS } from '@maka/core';
import {
  isMakaUri,
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from '@maka/ui/maka-uri';

describe('parseMakaUri — scheme gate', () => {
  it('rejects non-maka schemes', () => {
    assert.equal(parseMakaUri('https://example.com/'), null);
    assert.equal(parseMakaUri('http://settings/account'), null);
    assert.equal(parseMakaUri('file:///etc/passwd'), null);
    assert.equal(parseMakaUri('javascript:alert(1)'), null);
    assert.equal(parseMakaUri('data:text/html,<script>'), null);
  });

  it('rejects mixed-case scheme writes (Maka:, MAKA:)', () => {
    // The parser is intentionally strict here so a prompt-injected
    // assistant can't slip past with `Maka://settings/account`.
    assert.equal(parseMakaUri('Maka://settings/account'), null);
    assert.equal(parseMakaUri('MAKA://settings/account'), null);
    assert.equal(parseMakaUri('MaKa://settings/account'), null);
  });

  it('rejects empty / non-string inputs', () => {
    assert.equal(parseMakaUri(''), null);
    // @ts-expect-error — intentional bad input
    assert.equal(parseMakaUri(null), null);
    // @ts-expect-error — intentional bad input
    assert.equal(parseMakaUri(undefined), null);
    // @ts-expect-error — intentional bad input
    assert.equal(parseMakaUri(42), null);
  });

  it('rejects oversized raw hrefs before reaching URL()', () => {
    const giant = 'maka://compose?text=' + 'x'.repeat(8192);
    assert.equal(parseMakaUri(giant), null);
  });

  it('rejects malformed maka: hrefs', () => {
    assert.equal(parseMakaUri('maka://'), null);
    assert.equal(parseMakaUri('maka:settings/account'), null); // no `//`
  });
});

describe('parseMakaUri — settings', () => {
  it('accepts every known SettingsSection', () => {
    for (const s of SETTINGS_SECTIONS) {
      const dest = parseMakaUri(`maka://settings/${s}`);
      assert.deepEqual(dest, { kind: 'settings', section: s }, `section=${s}`);
    }
  });

  it('rejects unknown sections', () => {
    assert.equal(parseMakaUri('maka://settings/zzz'), null);
    assert.equal(parseMakaUri('maka://settings/account-list'), null);
    assert.equal(parseMakaUri('maka://settings/admin'), null);
  });

  it('rejects empty / missing section', () => {
    assert.equal(parseMakaUri('maka://settings/'), null);
    assert.equal(parseMakaUri('maka://settings'), null);
  });

  it('rejects sub-paths under settings', () => {
    assert.equal(parseMakaUri('maka://settings/account/edit'), null);
    assert.equal(parseMakaUri('maka://settings/account/../tools'), null);
  });

  it('rejects query / fragment on settings', () => {
    assert.equal(parseMakaUri('maka://settings/account?force=1'), null);
    assert.equal(parseMakaUri('maka://settings/account#section'), null);
  });

  it('dispatches by host, not by pathname-segment-0', () => {
    // `URL('maka://settings/account')` exposes:
    //   host = 'settings', pathname = '/account'
    // If the parser ever regresses to "split path and take [0]" it
    // would treat the section "settings" as the namespace and the
    // (now-missing) section as undefined. Lock the host invariant.
    const dest = parseMakaUri('maka://settings/account');
    assert.deepEqual(dest, { kind: 'settings', section: 'account' });
  });

  it('rejects uppercase host variants (maka: is a non-special scheme so URL keeps host as-is)', () => {
    // For "special" URL schemes (http, https, ftp, ws, wss, ftp,
    // file) the WHATWG URL parser lowercases the hostname. For
    // every other scheme — including `maka:` — the hostname is
    // preserved verbatim. So `new URL('maka://SETTINGS/account')`
    // exposes `hostname === 'SETTINGS'`, which does NOT match our
    // case-sensitive switch on `'settings'`. The parser returns
    // null. This is strictly more conservative than lowercasing
    // would be — locking it in.
    assert.equal(parseMakaUri('maka://SETTINGS/account'), null);
    assert.equal(parseMakaUri('maka://Settings/account'), null);
    assert.equal(parseMakaUri('maka://COMPOSE?text=hi'), null);
  });
});

describe('parseMakaUri — compose', () => {
  it('accepts a plain text param', () => {
    const dest = parseMakaUri('maka://compose?text=hello');
    assert.deepEqual(dest, { kind: 'compose', text: 'hello' });
  });

  it('URL-decodes the text param (UTF-8)', () => {
    const dest = parseMakaUri('maka://compose?text=%E4%BD%A0%E5%A5%BD');
    assert.deepEqual(dest, { kind: 'compose', text: '你好' });
  });

  it('accepts text with spaces and punctuation', () => {
    const dest = parseMakaUri('maka://compose?text=Hello%20world%21');
    assert.deepEqual(dest, { kind: 'compose', text: 'Hello world!' });
  });

  it('rejects empty text', () => {
    assert.equal(parseMakaUri('maka://compose?text='), null);
  });

  it('rejects missing text param', () => {
    assert.equal(parseMakaUri('maka://compose'), null);
    assert.equal(parseMakaUri('maka://compose?other=value'), null);
  });

  it('rejects text exceeding decoded length cap', () => {
    // 5000 chars of text → past the 4096 cap.
    const long = 'a'.repeat(5000);
    assert.equal(parseMakaUri(`maka://compose?text=${long}`), null);
  });

  it('rejects compose sub-paths', () => {
    assert.equal(parseMakaUri('maka://compose/run?text=hi'), null);
    assert.equal(parseMakaUri('maka://compose/admin?text=hi'), null);
  });

  it('treats trailing slash as no path (accept)', () => {
    const dest = parseMakaUri('maka://compose/?text=hi');
    assert.deepEqual(dest, { kind: 'compose', text: 'hi' });
  });
});

describe('parseMakaUri — unsupported namespaces (action runners)', () => {
  it('rejects maka://tool/... (no action execution)', () => {
    assert.equal(parseMakaUri('maka://tool/run'), null);
    assert.equal(parseMakaUri('maka://tool/Bash?cmd=ls'), null);
  });

  it('rejects maka://auth/... (no auth flow trigger)', () => {
    assert.equal(parseMakaUri('maka://auth/login'), null);
    assert.equal(parseMakaUri('maka://auth/oauth?provider=claude'), null);
  });

  it('rejects maka://exec/... and other action namespaces', () => {
    assert.equal(parseMakaUri('maka://exec/shell'), null);
    assert.equal(parseMakaUri('maka://run/skill'), null);
    assert.equal(parseMakaUri('maka://mcp/connect'), null);
  });

  it('rejects maka://session/... (defer to session navigation API)', () => {
    // PR-RENDER-2 review explicitly defers this. Lock the null
    // behavior so when a real session API arrives, this test will
    // need to be updated alongside.
    assert.equal(parseMakaUri('maka://session/abc-123'), null);
  });

  it('rejects maka://runtime/... (tool resource refs, not UI navigation)', () => {
    assert.equal(parseMakaUri('maka://runtime/background-tasks/shell-run-1'), null);
  });

  it('rejects empty host', () => {
    assert.equal(parseMakaUri('maka:///account'), null);
  });

  it('rejects host with userinfo / port', () => {
    assert.equal(parseMakaUri('maka://user@settings/account'), null);
    assert.equal(parseMakaUri('maka://settings:9999/account'), null);
  });
});

describe('isMakaUri', () => {
  it('returns true for any string starting with maka:', () => {
    assert.equal(isMakaUri('maka://settings/account'), true);
    assert.equal(isMakaUri('maka://tool/run'), true); // valid scheme, just unsupported namespace
    assert.equal(isMakaUri('maka:'), true);
  });

  it('returns false for other schemes', () => {
    assert.equal(isMakaUri('https://example.com/'), false);
    assert.equal(isMakaUri('Maka://settings/account'), false); // case-sensitive
    assert.equal(isMakaUri('   maka://settings/account'), false); // no whitespace trim
  });

  it('returns false for non-strings', () => {
    // @ts-expect-error — intentional bad input
    assert.equal(isMakaUri(null), false);
    // @ts-expect-error — intentional bad input
    assert.equal(isMakaUri(undefined), false);
  });
});

describe('isMakaUriCandidate — case-insensitive renderer probe (@kenji msg 7fb8d15c)', () => {
  // The renderer needs to catch ANY case-variant of `maka:` so that
  // `Maka://settings/account` etc. route to the broken-link inline
  // error rather than falling through to external `<a target=_blank>`.
  // `parseMakaUri` still strictly accepts only lowercase `maka:`,
  // so case-variants here cause `parseMakaUri === null` AND
  // `isMakaUriCandidate === true` → broken-link render.

  it('returns true for lowercase maka:', () => {
    assert.equal(isMakaUriCandidate('maka://settings/account'), true);
  });

  it('returns true for uppercase / mixed-case scheme', () => {
    assert.equal(isMakaUriCandidate('Maka://settings/account'), true);
    assert.equal(isMakaUriCandidate('MAKA://settings/account'), true);
    assert.equal(isMakaUriCandidate('MaKa://compose?text=hi'), true);
  });

  it('returns false for other schemes', () => {
    assert.equal(isMakaUriCandidate('https://example.com/'), false);
    assert.equal(isMakaUriCandidate('javascript:alert(1)'), false);
    assert.equal(isMakaUriCandidate('makafake://oops'), false);
  });

  it('returns false for non-strings', () => {
    // @ts-expect-error — defensive
    assert.equal(isMakaUriCandidate(null), false);
    // @ts-expect-error — defensive
    assert.equal(isMakaUriCandidate(undefined), false);
    // @ts-expect-error — defensive
    assert.equal(isMakaUriCandidate(42), false);
  });

  it('case-variants are candidate=true but parseMakaUri=null → renderer renders broken-link', () => {
    // The two halves of the gate combined: this is the contract the
    // renderer relies on for "Maka://... must NOT navigate".
    for (const href of ['Maka://settings/account', 'MAKA://compose?text=hi', 'MaKa://settings/health']) {
      assert.equal(isMakaUriCandidate(href), true, `candidate true for ${href}`);
      assert.equal(parseMakaUri(href), null, `parseMakaUri null for ${href}`);
    }
  });
});

describe('isSafeExternalScheme — explicit external allowlist (@kenji msg 7fb8d15c + 73e92ef0)', () => {
  it('accepts http: / https: / mailto: only', () => {
    assert.equal(isSafeExternalScheme('http://example.com'), true);
    assert.equal(isSafeExternalScheme('https://example.com/path?q=1'), true);
    assert.equal(isSafeExternalScheme('mailto:user@example.com'), true);
  });

  it('rejects dangerous schemes', () => {
    assert.equal(isSafeExternalScheme('javascript:alert(1)'), false);
    assert.equal(isSafeExternalScheme('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isSafeExternalScheme('file:///etc/passwd'), false);
    assert.equal(isSafeExternalScheme('vbscript:msgbox("x")'), false);
  });

  it('rejects maka: scheme (handled by the internal path, not external)', () => {
    assert.equal(isSafeExternalScheme('maka://settings/account'), false);
    assert.equal(isSafeExternalScheme('Maka://settings/account'), false);
  });

  it('rejects custom / unknown schemes', () => {
    assert.equal(isSafeExternalScheme('ms-excel://something'), false);
    assert.equal(isSafeExternalScheme('telnet://host'), false);
    assert.equal(isSafeExternalScheme('ftp://host'), false);
  });

  it('rejects garbage / unparseable hrefs', () => {
    assert.equal(isSafeExternalScheme(''), false);
    assert.equal(isSafeExternalScheme('not a url'), false);
    assert.equal(isSafeExternalScheme('://no-scheme'), false);
  });

  it('rejects bare emails without mailto: prefix (parser must see real mailto URL)', () => {
    // @kenji msg 73e92ef0: bare `user@example.com` is not a URL and
    // must not auto-link. The C2 PR doesn't introduce email
    // autolinking; this test locks that we don't accidentally
    // accept it via a prefix-match shortcut.
    assert.equal(isSafeExternalScheme('user@example.com'), false);
    assert.equal(isSafeExternalScheme('mailto-info:contact'), false);
  });

  it('rejects non-strings', () => {
    // @ts-expect-error — defensive
    assert.equal(isSafeExternalScheme(null), false);
    // @ts-expect-error — defensive
    assert.equal(isSafeExternalScheme(undefined), false);
    // @ts-expect-error — defensive
    assert.equal(isSafeExternalScheme(42), false);
  });
});
