import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  matchPromptHistory,
  PROMPT_HISTORY_MATCH_MIN_DRAFT,
} from '../prompt-history-match.js';

/** Entries are stored oldest-first, so the last one is the newest. */
const HISTORY = ['帮我写一个测试', '帮我写一个 README', '帮我改一下样式'];

describe('matchPromptHistory', () => {
  it('completes the draft with the remainder of the newest matching entry', () => {
    assert.equal(matchPromptHistory('帮我改', HISTORY), '一下样式');
    // Two entries share this prefix; the newer of the two wins.
    assert.equal(matchPromptHistory('帮我写一个 ', HISTORY), 'README');
  });

  it('returns only the remainder so the typed prefix is never rewritten', () => {
    const rest = matchPromptHistory('帮我写一个测', HISTORY);
    assert.equal(rest, '试');
    assert.equal(`帮我写一个测${rest}`, '帮我写一个测试');
  });

  it('ignores case on the second pass while preserving what the user typed', () => {
    const rest = matchPromptHistory('fix the', ['Fix the failing test']);
    assert.equal(rest, ' failing test');
    // The stored capital F is not forced back onto the draft.
    assert.equal(`fix the${rest}`, 'fix the failing test');
  });

  it('prefers an exact-case match over a newer case-insensitive one', () => {
    const entries = ['fix the exact one', 'Fix the newer one'];
    assert.equal(matchPromptHistory('fix the', entries), ' exact one');
  });

  it('stays quiet when there is nothing left to complete', () => {
    assert.equal(matchPromptHistory('帮我改一下样式', HISTORY), null);
    assert.equal(matchPromptHistory('完全没见过的输入', HISTORY), null);
    assert.equal(matchPromptHistory('帮我改', []), null);
  });

  it('stays quiet until the draft is long enough to distinguish prompts', () => {
    assert.equal(PROMPT_HISTORY_MATCH_MIN_DRAFT, 2);
    assert.equal(matchPromptHistory('帮', ['帮我改一下样式']), null);
    assert.equal(matchPromptHistory('  ', ['  留白开头的历史']), null);
    assert.equal(matchPromptHistory('帮我', ['帮我改一下样式']), '改一下样式');
  });

  it('matches history and nothing else, including drafts that open with a trigger', () => {
    // Whether a trigger menu owns the caret and Tab is the editor's question,
    // asked of the editor. A composer without mention sources must still
    // complete its own `/review …` history.
    const entries = ['/review 这段实现', '@src/app.tsx 看一下'];
    assert.equal(matchPromptHistory('/review', entries), ' 这段实现');
    assert.equal(matchPromptHistory('@src/', entries), 'app.tsx 看一下');
  });

  it('completes a multi-line draft from the end of its last line', () => {
    assert.equal(matchPromptHistory('第一行\n第二行', ['第一行\n第二行的内容']), '的内容');
  });
});
