import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { ToolTrow } from '../tool-activity.js';
import { summarizeTrowTools } from '../tool-activity/trow-summary.js';
import type { ToolActivityItem } from '../materialize.js';

const toolActivitySource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tool-activity.tsx'),
  'utf8',
);

function renderToStaticMarkup(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

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

  it('keeps the failed count visible in the live summary (the group no longer force-opens on error)', () => {
    const items: ToolActivityItem[] = [
      { toolUseId: 'r1', toolName: 'Read', activityKind: 'read', status: 'completed', args: {} },
      { toolUseId: 'g1', toolName: 'Grep', activityKind: 'search', status: 'errored', args: {} },
    ];
    // Errored tools stay collapsed now, so the summary line is the failure
    // signal and must carry the count live, not only once settled.
    assert.equal(summarizeTrowTools(items, { live: true }), '正在读取 1 个文件，搜索 1 次，1 个失败');
    assert.equal(summarizeTrowTools(items), '读取 1 个文件，搜索 1 次，1 个失败');
  });

  it('marks an errored row with a visible 失败 word inside an expanded group', () => {
    const markup = renderToStaticMarkup(createElement(ToolTrow, {
      items: [
        // waiting_permission mounts the group panel in static markup, so the
        // per-row headers render.
        { toolUseId: 'w1', toolName: 'Write', activityKind: 'edit', status: 'waiting_permission', args: {}, intent: '写入配置' },
        { toolUseId: 'e1', toolName: 'Bash', activityKind: 'command', status: 'errored', args: {}, intent: '运行测试' },
      ] satisfies ToolActivityItem[],
    }));
    // A collapsed errored row must not rely on the destructive tint alone —
    // the failure is a word, not just a color.
    assert.match(markup, /运行测试 · 失败/);
  });

  it('ToolTrowRow never reintroduces the per-row settle fade or the motion abstraction', () => {
    // The per-row seam is a light-band stop only. The group keeps one
    // SETTLE_FADE (its summary span); rows must not bring back the motion
    // abstraction (deriveToolRowMotion / motion.* / settleFade) that would
    // re-stack parallel fades. A dynamic running→settled rerender contract is
    // tracked separately (packages/ui has only renderToStaticMarkup); this
    // source contract locks the implementation shape until that infra exists.
    assert.doesNotMatch(toolActivitySource, /deriveToolRowMotion/);
    assert.doesNotMatch(toolActivitySource, /\bmotion\.(settling|shimmer|settled)\b/);
    assert.doesNotMatch(toolActivitySource, /\bsettleFade\b/);
    assert.equal((toolActivitySource.match(/\bSETTLE_FADE\b/g) ?? []).length, 2);
  });
});
