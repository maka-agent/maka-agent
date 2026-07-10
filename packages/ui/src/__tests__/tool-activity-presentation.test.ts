import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredMessage } from '@maka/core';
import { ToolActivity, ToolTrow } from '../tool-activity.js';
import {
  createToolDisclosureState,
  deriveToolActivityPresentation,
  setToolDisclosureOpen,
  syncToolDisclosureState,
} from '../tool-activity/presentation.js';
import { materializeTools, type ToolActivityItem } from '../materialize.js';

function renderTool(item: ToolActivityItem): string {
  return renderToStaticMarkup(createElement(ToolTrow, { items: [item] }));
}

describe('tool activity presentation', () => {
  it('prefers a declared semantic kind over the legacy tool-name fallback', () => {
    const item: ToolActivityItem = {
      toolUseId: 'tool-kind',
      toolName: 'Read',
      activityKind: 'command',
      status: 'running',
      args: {},
    };

    assert.equal(deriveToolActivityPresentation(item).kind, 'command');
  });

  it('materializes a persisted activity kind for replay', () => {
    const messages: StoredMessage[] = [{
      type: 'tool_call',
      id: 'tool-replay',
      turnId: 'turn-replay',
      ts: 1,
      toolName: 'CustomPatch',
      activityKind: 'edit',
      args: {},
    }];

    assert.equal(materializeTools(messages)[0]?.activityKind, 'edit');
  });

  it('keeps a running command detail collapsed by default', () => {
    const markup = renderTool({
      toolUseId: 'tool-running',
      toolName: 'Bash',
      intent: '检查当前项目结构',
      status: 'running',
      args: { command: 'Get-ChildItem -Recurse -Depth 1' },
      outputChunks: [
        { seq: 1, stream: 'stdout', text: 'packages\n', redacted: false, createdAt: 1 },
      ],
    });

    assert.doesNotMatch(markup, /Get-ChildItem/);
    assert.doesNotMatch(markup, /实时输出/);
    assert.match(markup, /检查当前项目结构/);
  });

  it('preserves a manual expansion across ordinary status changes', () => {
    const running: ToolActivityItem = {
      toolUseId: 'tool-manual',
      toolName: 'Bash',
      status: 'running',
      args: { command: 'npm test' },
    };
    const completed: ToolActivityItem = {
      ...running,
      status: 'completed',
    };
    const initial = createToolDisclosureState(deriveToolActivityPresentation(running));
    const expanded = setToolDisclosureOpen(initial, true);

    assert.deepEqual(
      syncToolDisclosureState(expanded, deriveToolActivityPresentation(completed)),
      { open: true, manuallySet: true },
    );
  });

  it('opens a newly errored tool even after an earlier manual collapse', () => {
    const running: ToolActivityItem = {
      toolUseId: 'tool-error',
      toolName: 'Bash',
      status: 'running',
      args: { command: 'npm test' },
    };
    const errored: ToolActivityItem = {
      ...running,
      status: 'errored',
    };
    const collapsed = setToolDisclosureOpen(
      createToolDisclosureState(deriveToolActivityPresentation(running)),
      false,
    );

    assert.deepEqual(
      syncToolDisclosureState(collapsed, deriveToolActivityPresentation(errored)),
      { open: true, manuallySet: false },
    );
  });

  it('shows diagnostic flags without exposing transport chunk counts', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-output',
        toolName: 'Bash',
        status: 'errored',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'one\n', redacted: false, createdAt: 1 },
          { seq: 2, stream: 'stdout', text: 'two\n', redacted: true, createdAt: 2 },
          { seq: 3, stream: 'stderr', text: 'failed\n', redacted: false, createdAt: 3 },
        ],
        outputTruncated: true,
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, /stdout\s+2/i);
    assert.doesNotMatch(markup, /stderr\s+1/i);
    assert.match(markup, /stderr/i);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /已截断/);
  });
});
