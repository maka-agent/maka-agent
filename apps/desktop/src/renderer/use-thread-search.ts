/**
 * `useThreadSearch` — renderer hook over `window.maka.search.thread()`.
 *
 * Anchors:
 *   - Scope sign-off: xuan msg `6e7372c5` (on top of `8e175a5a`).
 *   - Backend: PR-SEARCH-2 (`770ef55`) + PR-SEARCH-2.5 (`809875a`).
 *   - Contract: `@maka/core/search` types.
 *
 * Scope: this hook is renderer-only consumption of the existing
 * `search:thread` IPC. It does NOT add a new IPC channel, does NOT
 * write search history / saved filters / telemetry, does NOT construct
 * `maka://session` URIs, does NOT touch storage. It exists so the
 * Command Palette can surface content matches alongside its existing
 * session-name + action commands.
 *
 * Mirrors the `useOnboardingSnapshot` race-defense pattern: ticket-
 * based stale-response control + unmount safety. Old queries cannot
 * overwrite newer state; setState after unmount is a no-op.
 *
 * Per xuan `6e7372c5` review priorities:
 *   - Old query result MUST NOT overwrite new query result.
 *   - setState after unmount MUST NOT fire.
 *   - Snippet rendering MUST be plain text — caller renders via
 *     `<span>{result.snippet}</span>`, never `dangerouslySetInnerHTML`.
 *   - Query body MUST NOT enter telemetry / localStorage / any
 *     persistence path — this hook never logs or persists.
 *   - `incognito_active` produces a distinct state the UI can render as
 *     a single disabled command with a fixed Chinese message.
 *   - Hit with missing `target.sessionId` is dropped in the hook
 *     before reaching the UI.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { SearchErrorReason, SearchRequest, SearchResult } from '@maka/core';

/** Min query length before issuing an IPC request. Avoids one-char churn. */
export const THREAD_SEARCH_MIN_QUERY_CODE_POINTS = 2;

/** Debounce window (ms) between keystrokes and IPC dispatch. */
export const THREAD_SEARCH_DEBOUNCE_MS = 180;

/**
 * Result limit handed to the IPC. Matches core `SEARCH_MAX_LIMIT=10`
 * — bumped from 5 to 10 per xuan `fd675604` to align with the scope
 * messaged in `9fb2ab60`. The backend still clamps to
 * `SEARCH_MAX_LIMIT`, so this just makes the renderer ask for the
 * full set.
 */
export const THREAD_SEARCH_DEFAULT_LIMIT = 10;

/**
 * Discriminated state union the consumer pattern-matches on.
 *
 *   - `idle`     — no query, or query too short.
 *   - `loading`  — IPC in flight; previous results may still be visible
 *                  via `pendingResults` but UI may also choose to show
 *                  a skeleton.
 *   - `results`  — IPC returned an array of hits.
 *   - `blocked`  — IPC returned `incognito_active` (or any future
 *                  reason that maps to a blocked UI state).
 *   - `error`    — IPC returned a different error envelope. Generalized
 *                  message; UI shows a generic failure tile.
 */
export type ThreadSearchState =
  | { kind: 'idle' }
  | { kind: 'loading'; query: string }
  | { kind: 'results'; query: string; hits: NormalizedThreadHit[] }
  | { kind: 'blocked'; query: string; reason: SearchErrorReason; message: string }
  | { kind: 'error'; query: string; reason: SearchErrorReason; message: string };

/**
 * Hit shape narrowed for the UI. Always has a thread `target` with a
 * non-empty `sessionId` — hits without that are dropped at the hook
 * boundary per xuan `6e7372c5`.
 */
export interface NormalizedThreadHit {
  sessionId: string;
  turnId?: string;
  title: string;
  summary?: string;
  snippet?: string;
  truncated?: boolean;
}

export interface UseThreadSearchDeps {
  /**
   * The IPC binding. Production wiring uses
   * `(req) => window.maka.search.thread(req)`; tests pass a fake.
   */
  runSearch(request: SearchRequest): Promise<
    SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }
  >;
}

export interface UseThreadSearchResult {
  state: ThreadSearchState;
}

export function isThreadSearchQueryDispatchable(query: string): boolean {
  return Array.from(query.trim()).length >= THREAD_SEARCH_MIN_QUERY_CODE_POINTS;
}

/**
 * React-less poller. Owns the ticket counter + unmount flag so the
 * stale-response defense and lifecycle gating are testable without a
 * DOM. The React hook (`useThreadSearchImpl`) is a thin shell over
 * this — mirrors the `createOnboardingSnapshotPoller` pattern in
 * `use-onboarding-snapshot.ts`.
 *
 * Callbacks ARE NOT called after `dispose()`. Old query results that
 * arrive after a newer query started are discarded — the latest
 * ticket wins.
 */
export interface ThreadSearchPollerCallbacks {
  onState(next: ThreadSearchState): void;
}

export interface ThreadSearchPoller {
  /** Dispatch a query. Below `THREAD_SEARCH_MIN_QUERY_CODE_POINTS` is reset to idle. */
  setQuery(query: string): void;
  /** Stop accepting callbacks. Pending IPC responses become no-ops. */
  dispose(): void;
}

export function createThreadSearchPoller(
  deps: UseThreadSearchDeps,
  callbacks: ThreadSearchPollerCallbacks,
): ThreadSearchPoller {
  let inflightTicket = 0;
  let mounted = true;

  function emit(state: ThreadSearchState): void {
    if (!mounted) return;
    callbacks.onState(state);
  }

  return {
    setQuery(query: string): void {
      if (!isThreadSearchQueryDispatchable(query)) {
        // Every keystroke below threshold invalidates any inflight
        // ticket so a previously-dispatched result cannot land on top.
        inflightTicket += 1;
        emit({ kind: 'idle' });
        return;
      }

      const trimmed = query.trim();
      const ticket = ++inflightTicket;
      emit({ kind: 'loading', query: trimmed });

      void (async () => {
        try {
          const response = await deps.runSearch({
            source: 'thread',
            query: trimmed,
            limit: THREAD_SEARCH_DEFAULT_LIMIT,
          });
          // Stale guard: if a newer query started since this dispatch,
          // discard the response.
          if (ticket !== inflightTicket) return;
          if (Array.isArray(response)) {
            const hits = normalizeHits(response);
            emit({ kind: 'results', query: trimmed, hits });
          } else if (response.reason === 'incognito_active') {
            emit({ kind: 'blocked', query: trimmed, reason: response.reason, message: response.message });
          } else {
            emit({ kind: 'error', query: trimmed, reason: response.reason, message: response.message });
          }
        } catch {
          if (ticket !== inflightTicket) return;
          // Never let an unexpected throw silently lose UI state. Show a
          // generic error envelope; do NOT log the query body.
          emit({
            kind: 'error',
            query: trimmed,
            reason: 'parse_error',
            message: '搜索暂时失败，请稍后重试。',
          });
        }
      })();
    },
    dispose(): void {
      mounted = false;
      inflightTicket += 1; // invalidate any pending response too
    },
  };
}

/**
 * Pure form. Tests pass `deps` directly; renderer uses the live binding
 * via `useThreadSearch`. Wraps `createThreadSearchPoller` with React
 * lifecycle (debounce + dispose on unmount).
 */
export function useThreadSearchImpl(query: string, deps: UseThreadSearchDeps): UseThreadSearchResult {
  const [state, setState] = useState<ThreadSearchState>({ kind: 'idle' });
  const pollerRef = useRef<ThreadSearchPoller | null>(null);

  if (pollerRef.current === null) {
    pollerRef.current = createThreadSearchPoller(deps, {
      onState: (next) => setState(next),
    });
  }

  // Dispose on unmount.
  useEffect(() => {
    const poller = pollerRef.current!;
    return () => poller.dispose();
  }, []);

  // Debounce keystrokes before dispatching.
  useEffect(() => {
    const poller = pollerRef.current!;
    if (!isThreadSearchQueryDispatchable(query)) {
      poller.setQuery(query);
      return;
    }
    const timer = setTimeout(() => {
      poller.setQuery(query);
    }, THREAD_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return { state };
}

/**
 * Live renderer binding. Consumes `window.maka.search.thread()` via the
 * existing preload bridge.
 */
export function useThreadSearch(
  query: string,
  deps: UseThreadSearchDeps = LIVE_DEPS,
): UseThreadSearchResult {
  return useThreadSearchImpl(query, deps);
}

const LIVE_DEPS: UseThreadSearchDeps = {
  runSearch: (request) => window.maka.search.thread(request),
};

/**
 * Drop hits without a valid `thread` target. Per xuan `6e7372c5`:
 * never fallback to URI construction; never let UI render an entry
 * without a navigable sessionId.
 *
 * Pure for unit tests.
 */
export function normalizeHits(results: SearchResult[]): NormalizedThreadHit[] {
  const hits: NormalizedThreadHit[] = [];
  for (const result of results) {
    const target = result.target;
    if (!target || target.kind !== 'thread') continue;
    if (!target.sessionId || target.sessionId.length === 0) continue;
    hits.push({
      sessionId: target.sessionId,
      ...(target.turnId ? { turnId: target.turnId } : {}),
      title: result.title,
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.snippet ? { snippet: result.snippet } : {}),
      ...(result.truncated ? { truncated: result.truncated } : {}),
    });
  }
  return hits;
}
