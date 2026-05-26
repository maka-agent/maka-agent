/**
 * Pure helper: turn a `ThreadSearchState` into Command Palette commands.
 *
 * Extracted from `command-palette.tsx` (which is a `.tsx` file) so the
 * helper can be unit-tested under the main-process tsconfig that does
 * NOT compile JSX. The palette imports `buildContentSearchCommands`
 * from here; this file imports the icon types from lucide but
 * contains no JSX itself.
 *
 * Anchors:
 *   - PR-SEARCH-2.6 scope sign-off: xuan msg `6e7372c5`.
 *   - State source: `use-thread-search.ts`.
 *
 * Rules (xuan `6e7372c5`):
 *   - Single command per blocked / error / loading / empty state.
 *   - One command per hit for `results` with non-empty `hits`.
 *   - Fixed Chinese main text for the `blocked` state.
 *   - Snippet rendered as `hint` (plain text via the palette's existing
 *     `<span>` slot; no `dangerouslySetInnerHTML`).
 *   - Query body is NOT echoed back into telemetry, history, or any
 *     persistence path — this helper only constructs in-memory data.
 */

import { EyeOff, Search } from 'lucide-react';
import type { Command } from './command-palette-types';
import type { NormalizedThreadHit, ThreadSearchState } from './use-thread-search';

export function buildContentSearchCommands(
  state: ThreadSearchState,
  onSelectSession?: (sessionId: string) => void,
): Command[] {
  switch (state.kind) {
    case 'idle':
      return [];
    case 'loading':
      return [
        {
          id: 'thread-search:loading',
          kind: 'action',
          label: '搜索中…',
          hint: `"${truncateForHint(state.query)}"`,
          group: '内容搜索',
          Icon: Search,
          keywords: [],
          // xuan `fd675604`: status tiles MUST be inert. `commit()`
          // gates on `disabled` and returns without firing run/close.
          disabled: true,
          run: () => undefined,
        },
      ];
    case 'blocked':
      // xuan `6e7372c5`: fixed Chinese main text + generalized hint;
      // no result count, no body. xuan `fd675604`: must be truly
      // disabled — `disabled: true` makes `commit()` skip both
      // `run()` and palette close.
      return [
        {
          id: 'thread-search:blocked',
          kind: 'action',
          label: '搜索已在隐私模式下停用',
          hint: state.message,
          group: '内容搜索',
          Icon: EyeOff,
          keywords: ['incognito', 'privacy', '隐私', '停用'],
          disabled: true,
          run: () => undefined,
        },
      ];
    case 'error':
      return [
        {
          id: 'thread-search:error',
          kind: 'action',
          label: '搜索失败',
          hint: state.message,
          group: '内容搜索',
          Icon: Search,
          keywords: [],
          disabled: true,
          run: () => undefined,
        },
      ];
    case 'results':
      if (state.hits.length === 0) {
        return [
          {
            id: 'thread-search:empty',
            kind: 'action',
            label: '没有匹配内容',
            hint: `"${truncateForHint(state.query)}"`,
            group: '内容搜索',
            Icon: Search,
            keywords: [],
            disabled: true,
            run: () => undefined,
          },
        ];
      }
      return state.hits.map((hit, index) => contentSearchHitCommand(hit, index, onSelectSession));
  }
}

function contentSearchHitCommand(
  hit: NormalizedThreadHit,
  index: number,
  onSelectSession?: (sessionId: string) => void,
): Command {
  return {
    id: `thread-search:hit:${hit.sessionId}:${hit.turnId ?? 'session'}:${index}`,
    kind: 'session',
    label: hit.title,
    hint: hit.snippet,
    group: '内容搜索',
    Icon: Search,
    keywords: [],
    run: () => {
      if (onSelectSession) onSelectSession(hit.sessionId);
    },
  };
}

/** Keep palette hints short — long queries overflow the row. */
function truncateForHint(query: string): string {
  const codePoints = Array.from(query);
  if (codePoints.length <= 24) return query;
  return codePoints.slice(0, 23).join('') + '…';
}
