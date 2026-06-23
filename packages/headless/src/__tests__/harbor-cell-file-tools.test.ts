import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarborCellLocalToolExecutor } from '../harbor-cell.js';
import { buildIsolatedHeadlessTools } from '../tools.js';

// Real local executor (actual child processes). Regression guard for the
// bounded-tail change: Read/Glob/Grep run through the SAME executor.exec as Bash,
// so when Bash's bounded tail was (briefly) the default exec semantics, a large
// file or result was silently head-dropped to a tail. Read must return the FULL
// file, head-first — only Bash opts into a bounded tail.

const toolCtx = (cwd: string) => ({
  sessionId: 's',
  turnId: 't',
  cwd,
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
});

function tool(tools: ReturnType<typeof buildIsolatedHeadlessTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe('Harbor local executor file tools (real spawn)', () => {
  test('Read returns the FULL file head-first, not a bounded tail (P1 regression)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-harbor-read-'));
    // ~2MB (under the 10MB exec cap) bracketed by markers. A bounded tail would
    // silently drop HEAD_MARKER; Read must return the whole file.
    const body = 'HEAD_MARKER\n' + 'a'.repeat(2 * 1024 * 1024) + '\nTAIL_MARKER\n';
    await writeFile(join(cwd, 'big.txt'), body, 'utf8');
    const tools = buildIsolatedHeadlessTools(createHarborCellLocalToolExecutor());

    const result = (await tool(tools, 'Read').impl({ path: 'big.txt' }, toolCtx(cwd))) as { content: string };

    assert.ok(result.content.includes('HEAD_MARKER'), 'head retained — Read is not tail-bounded');
    assert.ok(result.content.includes('TAIL_MARKER'), 'tail retained');
    assert.ok(result.content.length >= 2 * 1024 * 1024, 'full file content returned, not a 1MB tail');
    // (Glob/Grep share the same command-backed executor.exec with no boundedTail
    //  flag — see the "only Bash opts into bounded-tail" contract test — so this
    //  full-output guarantee covers them too without generating MBs of matches.)
  });
});
