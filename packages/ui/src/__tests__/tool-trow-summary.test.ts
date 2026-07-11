import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolTrow } from '../tool-activity.js';
import { summarizeTrowTools } from '../tool-activity/trow-summary.js';
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

  it('multi-tool group icon uses the first bucket kind, not the active tool', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'running', args: {} },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'running', args: {} },
      ] satisfies ToolActivityItem[],
    }));
    // 首个 bucket = read = FileText，不跟 active (Grep = Search) 切
    assert.match(markup, /lucide-file-text/);
    assert.doesNotMatch(markup, /lucide-search/);
  });

  it('live summary omits the failed count (it changes mid-group); settled includes it', () => {
    const items: ToolActivityItem[] = [
      { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'errored', args: {} },
    ];
    assert.equal(summarizeTrowTools(items, { live: true }), '正在读取 1 个文件，搜索 1 次');
    assert.equal(summarizeTrowTools(items), '读取 1 个文件，搜索 1 次，1 个失败');
  });

  it('rows settle by light-band stop, never an opacity fade class (static contract)', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
        { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'errored', args: {} },
      ] satisfies ToolActivityItem[],
    }));
    // errored forces the disclosure open so rows render; no row carries the
    // settle-fade animation — the per-row seam is a light-band stop. (A full
    // running→settled rerender contract needs dynamic test infrastructure that
    // packages/ui lacks; this static contract locks the rendered output.)
    assert.match(markup, /data-trow="row"/);
    assert.doesNotMatch(markup, /maka-stream-fade-in/);
  });
});