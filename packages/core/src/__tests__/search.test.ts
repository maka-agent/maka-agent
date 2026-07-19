import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SEARCH_MAX_LIMIT,
  normalizeSearchDomain,
  normalizeSearchDomainList,
  normalizeSearchLimit,
  normalizeSearchQuery,
  normalizeSearchUrl,
  rewriteSearchQueryForFreshness,
  searchDomainMatches,
  type SearchErrorReason,
  type SearchResult,
  type SearchResultTarget,
} from '../search.js';

describe('search contract normalizers (PR-SEARCH-0)', () => {
  describe('normalizeSearchQuery', () => {
    it('trims and preserves CJK query text', () => {
      assert.deepEqual(normalizeSearchQuery('  最新 AI 新闻  '), {
        ok: true,
        value: '最新 AI 新闻',
      });
    });

    it('rejects non-string and empty query', () => {
      for (const bad of [undefined, null, 42, true, {}, [], '   ']) {
        const result = normalizeSearchQuery(bad);
        assert.equal(result.ok, false, `bad=${String(bad)}`);
        if (!result.ok) {
          assert.equal(result.reason, 'invalid_query');
        }
      }
    });
  });

  describe('normalizeSearchLimit', () => {
    it('defaults omitted values', () => {
      assert.deepEqual(normalizeSearchLimit(undefined), { ok: true, value: 5 });
      assert.deepEqual(normalizeSearchLimit(null), { ok: true, value: 5 });
    });

    it('truncates and clamps to max', () => {
      assert.deepEqual(normalizeSearchLimit(3.8), { ok: true, value: 3 });
      assert.deepEqual(normalizeSearchLimit(999), { ok: true, value: SEARCH_MAX_LIMIT });
    });

    it('rejects invalid limits', () => {
      for (const bad of ['5', NaN, Infinity, 0, -1]) {
        const result = normalizeSearchLimit(bad);
        assert.equal(result.ok, false, `bad=${String(bad)}`);
      }
    });
  });

  describe('domains', () => {
    it('normalizes hostnames and URLs', () => {
      assert.deepEqual(normalizeSearchDomain(' HTTPS://WWW.Example.COM/path?q=1 '), {
        ok: true,
        value: 'example.com',
      });
      assert.deepEqual(normalizeSearchDomain('docs.example.com'), {
        ok: true,
        value: 'docs.example.com',
      });
    });

    it('dedupes domain arrays after canonicalization', () => {
      assert.deepEqual(
        normalizeSearchDomainList(['www.example.com', 'https://example.com/a', 'docs.example.com']),
        {
          ok: true,
          value: ['example.com', 'docs.example.com'],
        },
      );
    });

    it('rejects invalid domain payloads with invalid_domain, not blocked_domain', () => {
      for (const bad of [undefined, null, 42, {}, [], '', '   ', 'https://']) {
        const result = normalizeSearchDomain(bad);
        assert.equal(result.ok, false, `bad=${String(bad)}`);
        if (!result.ok) {
          assert.equal(result.reason, 'invalid_domain');
        }
      }
      const listResult = normalizeSearchDomainList('example.com');
      assert.equal(listResult.ok, false);
      if (!listResult.ok) {
        assert.equal(listResult.reason, 'invalid_domain');
      }
    });

    it('uses suffix matching', () => {
      assert.equal(searchDomainMatches('docs.example.com', ['example.com']), true);
      assert.equal(searchDomainMatches('badexample.com', ['example.com']), false);
      assert.equal(searchDomainMatches('example.com', ['example.com']), true);
    });
  });

  describe('normalizeSearchUrl', () => {
    it('allows http/https and strips tracking params', () => {
      assert.deepEqual(
        normalizeSearchUrl('https://example.com/page?utm_source=x&keep=1&gclid=abc#hash'),
        { ok: true, value: 'https://example.com/page?keep=1#hash' },
      );
    });

    it('rejects active or local-only schemes', () => {
      for (const bad of [
        'javascript:alert(1)',
        'file:///tmp/a',
        'data:text/html,hi',
        'blob:https://example.com/id',
        'chrome-extension://abc/index.html',
      ]) {
        const result = normalizeSearchUrl(bad);
        assert.equal(result.ok, false, `bad=${bad}`);
        if (!result.ok) {
          assert.equal(result.reason, 'blocked_scheme');
        }
      }
    });
  });

  describe('freshness rewrite', () => {
    const now = new Date('2026-05-25T00:00:00Z');

    it('appends the current year for fresh queries without a year', () => {
      assert.equal(
        rewriteSearchQueryForFreshness('latest model news', now),
        'latest model news 2026',
      );
      assert.equal(rewriteSearchQueryForFreshness('今天 AI 新闻', now), '今天 AI 新闻 2026');
    });

    it('replaces stale year for fresh queries', () => {
      assert.equal(
        rewriteSearchQueryForFreshness('latest OpenAI news 2024', now),
        'latest OpenAI news 2026',
      );
    });

    it('does not rewrite historical queries', () => {
      assert.equal(
        rewriteSearchQueryForFreshness('history of AI since 2019', now),
        'history of AI since 2019',
      );
      assert.equal(rewriteSearchQueryForFreshness('过去几年 AI 发展', now), '过去几年 AI 发展');
    });
  });

  /*
   * PR-SEARCH-1.5 (@xuan msg `772d8198` + `ac6bcbbe`):
   * `SearchResultTarget` closed discriminated union — typed navigation
   * hint for source kinds whose navigation does NOT map to a URL.
   * Today only `'thread'` exists. Web / web_fetch keep using `url`.
   *
   * This is a TS-contract-only packet — no runtime normalizer, only
   * shape pins.
   */
  /*
   * PR-SEARCH-2.5 (@xuan msg `57ca05cd` + `a91c61c6`):
   * `SearchErrorReason` closed union extended with `incognito_active`.
   * Returned both when the workspace is in incognito mode AND when the
   * privacy authority returned a malformed snapshot (fail-closed). Two
   * internal paths share the same reason to avoid an extra UI state;
   * the `message` field distinguishes them when needed.
   */
  describe('SearchErrorReason — PR-SEARCH-2.5 extension', () => {
    it('SearchErrorReason accepts the literal "incognito_active"', () => {
      const reason: SearchErrorReason = 'incognito_active';
      assert.equal(reason, 'incognito_active');
    });

    it('incognito_active is exhaustively handled at the type level', () => {
      // Exhaustiveness check: if a future reason is added, the switch
      // must handle it. Compile-time guarantee that consumers can
      // pattern-match without falling through.
      function classify(reason: SearchErrorReason): 'incognito' | 'other' {
        switch (reason) {
          case 'incognito_active':
            return 'incognito';
          case 'disabled':
          case 'missing_provider':
          case 'missing_credentials':
          case 'invalid_query':
          case 'invalid_domain':
          case 'invalid_url':
          case 'blocked_scheme':
          case 'blocked_domain':
          case 'timeout':
          case 'aborted':
          case 'needs_human_browser':
          case 'provider_error':
          case 'parse_error':
            return 'other';
        }
      }
      assert.equal(classify('incognito_active'), 'incognito');
      assert.equal(classify('disabled'), 'other');
      assert.equal(classify('invalid_query'), 'other');
    });
  });

  describe('SearchResultTarget contract (PR-SEARCH-1.5)', () => {
    it('thread target carries sessionId + optional turnId', () => {
      const withTurn: SearchResultTarget = {
        kind: 'thread',
        sessionId: 'session-abc',
        turnId: 'turn-xyz',
      };
      assert.equal(withTurn.kind, 'thread');
      assert.equal(withTurn.sessionId, 'session-abc');
      assert.equal(withTurn.turnId, 'turn-xyz');

      // turnId is optional — a hit at session level (e.g. title match)
      // may omit it.
      const withoutTurn: SearchResultTarget = {
        kind: 'thread',
        sessionId: 'session-only',
      };
      assert.equal(withoutTurn.kind, 'thread');
      assert.equal(withoutTurn.sessionId, 'session-only');
      assert.equal(withoutTurn.turnId, undefined);
    });

    it('SearchResult.target is optional and works for thread results', () => {
      const threadHit: SearchResult = {
        source: 'thread',
        title: 'PR-HEALTH-1 review',
        snippet: '...bot readiness single-authority...',
        target: { kind: 'thread', sessionId: 'session-abc', turnId: 'turn-xyz' },
      };
      assert.equal(threadHit.source, 'thread');
      assert.equal(threadHit.target?.kind, 'thread');
      if (threadHit.target?.kind === 'thread') {
        // Discriminated-union narrowing works.
        assert.equal(threadHit.target.sessionId, 'session-abc');
        assert.equal(threadHit.target.turnId, 'turn-xyz');
      } else {
        assert.fail('expected thread target kind to narrow');
      }
    });

    it('SearchResult for web does NOT require target (url is the navigation field)', () => {
      const webHit: SearchResult = {
        source: 'web',
        title: 'Example',
        url: 'https://example.com/article',
        snippet: 'example snippet',
      };
      assert.equal(webHit.source, 'web');
      assert.equal(webHit.target, undefined);
      assert.equal(webHit.url, 'https://example.com/article');
    });

    it('SearchResult for web_fetch does NOT require target', () => {
      const fetchHit: SearchResult = {
        source: 'web_fetch',
        title: 'Fetched page',
        url: 'https://example.com/page',
        markdown: '# Heading',
      };
      assert.equal(fetchHit.target, undefined);
      assert.equal(fetchHit.source, 'web_fetch');
    });

    // Compile-time defense: a hypothetical future variant would extend
    // the union, e.g.:
    //   | { kind: 'memory'; entryId: string }
    //   | { kind: 'activity'; from: number; to: number }
    // Adding such variants is a contract change requiring explicit review.
    // Today only `'thread'` is allowed.
    it('today the only target kind is "thread" (future variants require contract change)', () => {
      const t: SearchResultTarget = { kind: 'thread', sessionId: 's' };
      // Discriminant is literal-typed; no other kind is constructible
      // at compile time. Runtime check below mirrors the type-level
      // invariant.
      assert.equal(t.kind, 'thread');
      // List of currently-allowed kind values:
      const allowedKinds: Array<SearchResultTarget['kind']> = ['thread'];
      assert.equal(allowedKinds.length, 1);
      assert.ok(allowedKinds.includes(t.kind));
    });

    it('thread navigation does NOT use maka://session — caller resolves via sessionId state', () => {
      // PR-SEARCH-1.5 documents: `packages/ui/src/maka-uri.ts:24` defers
      // `maka://session/<id>` until a real session navigation contract.
      // Consumers MUST navigate via renderer state (sessionId selection
      // + turnId scroll-into-view), NOT by constructing a maka:// URI.
      // A search hit that wants navigation populates `target`, leaves
      // `url` undefined.
      const hit: SearchResult = {
        source: 'thread',
        title: 'Local hit',
        target: { kind: 'thread', sessionId: 's1' },
      };
      assert.equal(hit.url, undefined);
      assert.equal(hit.target?.kind, 'thread');
    });
  });
});
