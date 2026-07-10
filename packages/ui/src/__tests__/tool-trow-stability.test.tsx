import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolActivityItem } from '../materialize.js';
import { ToolTrow } from '../tool-activity.js';

function runningTool(id: string, name: string): ToolActivityItem {
  return { toolUseId: id, toolName: name, status: 'running', args: {} };
}

describe('ToolTrow stable structure', () => {
  it('keeps the same group root when a second tool arrives', () => {
    const first = runningTool('tool-1', 'Read');
    const one = renderToStaticMarkup(createElement(ToolTrow, { items: [first] }));
    const two = renderToStaticMarkup(createElement(ToolTrow, {
      items: [first, runningTool('tool-2', 'Grep')],
    }));

    assert.match(one, /data-trow="group"/);
    assert.doesNotMatch(one, /data-trow="row"/);
    assert.doesNotMatch(one, /data-panel-open/);
    assert.doesNotMatch(one, /<pre/);
    assert.match(two, /data-trow="group"/);
  });
});
