/**
 * PR-AGENT-WEB-SEARCH-TOOL-0 — static-analysis gate that the
 * recordToolInvocation wrapper in main.ts scrubs `argsSummary` for
 * the `WebSearch` tool. The query string is user-derived; persisting
 * it to telemetry would leak the user's search content into the
 * usage log.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

describe('WebSearch telemetry scrub contract', () => {
  it('main.ts recordToolInvocation drops argsSummary for WebSearch', async () => {
    // The ai-sdk backend wiring (with the recordToolInvocation scrub) moved into
    // session-stream.ts (arch R5); scan the combined main-process source.
    const src = await readMainProcessCombinedSource();
    // Cheap grep: the wrapper that branches on toolName === WEB_SEARCH_TOOL_NAME
    // must spread the event and explicitly drop argsSummary.
    assert.match(
      src,
      /toolName\s*===\s*WEB_SEARCH_TOOL_NAME[\s\S]*argsSummary:\s*undefined/,
      'main.ts recordToolInvocation must scrub argsSummary for WebSearch',
    );
  });
});
