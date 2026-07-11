import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderSessionListPanel } from './session-list-render-helpers.js';

describe('sidebar session row menu', () => {
  it('exposes one overflow trigger instead of four inline management buttons', () => {
    const markup = renderSessionListPanel();

    assert.match(markup, /<button(?=[^>]*data-slot="menu-trigger")(?=[^>]*aria-label="对话操作")[^>]*>/);
    assert.doesNotMatch(markup, /aria-label="置顶对话"/);
    assert.doesNotMatch(markup, /aria-label="重命名对话"/);
    assert.doesNotMatch(markup, /aria-label="归档对话"/);
    assert.doesNotMatch(markup, /aria-label="删除对话"/);
  });
});
