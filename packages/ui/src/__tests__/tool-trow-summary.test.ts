import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolTrow } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';

describe('tool trow summary aggregation', () => {
  it('multi-tool running summary shows aggregated bucket with 正在 prefix, not the active tool description', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'running', args: {}, intent: '读取 a.ts' },
        { toolUseId: 'r2', toolName: 'Read', activityKind: 'read', status: 'running', args: {}, intent: '读取 b.ts' },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'running', args: {}, intent: '搜索 foo' },
      ] satisfies ToolActivityItem[],
    }));

    // 整组 bucket 聚合 + "正在"前缀，不跟 active 工具走
    assert.match(markup, /正在读取 2 个文件，搜索 1 次/);
    // 不显示 active 工具的具体描述（避免并发时 1234567 跳）
    assert.doesNotMatch(markup, /搜索 foo/);
    assert.doesNotMatch(markup, /读取 b\.ts/);
  });

  it('counts the whole group including settled tools, so the summary does not decrement as tools finish', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'running', args: {} },
        { toolUseId: 'r2', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'running', args: {} },
      ] satisfies ToolActivityItem[],
    }));
    // 整组总数（含已完成），不随完成数递减 — 并行 result 一起返回时不 1234567
    assert.match(markup, /正在读取 2 个文件，搜索 1 次/);
  });
});