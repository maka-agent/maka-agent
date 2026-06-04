import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Settings usage dashboard contract', () => {
  it('keeps request filters scoped to the request log tab', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /usage\.activeTab === 'requests'/);
    assert.match(usagePage![0], /settingsUsageFilters/);
    assert.match(usagePage![0], /清除筛选/);
    assert.match(usagePage![0], /status: 'all', modelFilter: ''/);
    assert.match(
      usagePage![0],
      /\{usage\.activeTab === 'requests' && \([\s\S]*?<div className="settingsUsageFilters">/,
      'Usage filters must live under the requests-only conditional block',
    );
    assert.match(
      usagePage![0],
      /\{usage\.showDetails && \([\s\S]*?<input value=\{usage\.modelFilter\}/,
      'model/status request filters must be hidden until detail records are enabled',
    );
    assert.match(usagePage![0], /按模型或工具筛选/);
    assert.match(usagePage![0], /log\.model\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
    assert.match(usagePage![0], /\(log\.toolName \?\? ''\)\.toLowerCase\(\)\.includes\(normalizedModelFilter\)/);
  });

  it('shows a distinct empty state when request filters hide all logs', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(src, /requestEmpty=\{hasRequestFilters \? '没有符合筛选条件的请求记录' : '暂无请求记录'\}/);
    assert.match(src, /empty=\{props\.requestEmpty\}/);
  });

  it('makes the detail-records toggle control request log rendering', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /const showRequestDetails = usage\.activeTab === 'requests' && usage\.showDetails/);
    assert.match(usagePage![0], /usage\.activeTab === 'requests' && !usage\.showDetails/);
    assert.match(usagePage![0], /当前仅显示汇总指标/);
    assert.match(usagePage![0], /显示明细/);
    assert.match(usagePage![0], /showDetails: true/);
    assert.match(usagePage![0], /logs=\{showRequestDetails \? filteredLogs : \[\]\}/);
  });

  it('surfaces usage preference save failures instead of leaving filter controls silent', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usagePage = src.match(/function UsageSettingsPage\([\s\S]*?function UsageTable/);

    assert.ok(usagePage, 'Usage settings page block must exist');
    assert.match(usagePage![0], /async function updateUsage\(patch: Partial<AppSettings\['usage'\]>\): Promise<boolean>/);
    assert.match(
      usagePage![0],
      /try \{[\s\S]*await props\.onUpdate\(\{ usage: patch \}\)[\s\S]*return true[\s\S]*catch \(error\) \{[\s\S]*toast\.error\('保存使用统计设置失败', settingsActionErrorMessage\(error\)\)[\s\S]*return false/,
      'Usage settings updates must toast thrown save failures and report failure to callers',
    );
    assert.match(
      usagePage![0],
      /const saved = await updateUsage\(\{ range \}\);[\s\S]*if \(!saved\) return;[\s\S]*await props\.onReload\(range\)/,
      'Changing the usage range must not reload stats after the preference save fails',
    );
    assert.doesNotMatch(
      usagePage![0],
      /void props\.onUpdate\(\{ usage:/,
      'Usage filter controls must not fire-and-forget raw settings updates',
    );
  });

  it('does not render raw request status enums in the usage table', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usageTable = src.match(/function UsageTable\([\s\S]*?function SimpleStatsTable/);

    assert.ok(usageTable, 'Usage table block must exist');
    assert.match(usageTable![0], /usageRequestStatusLabel\(row\.status\)/);
    assert.match(src, /function usageRequestStatusLabel/);
    assert.match(src, /case 'success': return '成功'/);
    assert.match(src, /case 'error': return '错误'/);
    assert.doesNotMatch(
      usageTable![0],
      /,\s*row\.status\]\)/,
      'Usage request table must not render raw `success` / `error` enums directly',
    );
  });

  it('labels model and tool rows without rendering raw request kind enums', async () => {
    const src = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const usageTable = src.match(/function UsageTable\([\s\S]*?function usageRequestStatusLabel/);

    assert.ok(usageTable, 'Usage table block must exist');
    assert.match(usageTable![0], /headers=\{\['时间', '类型', '对象', '会话', 'Token', '费用', '延迟', '状态'\]\}/);
    assert.match(usageTable![0], /usageRequestKindLabel\(row\.kind\)/);
    assert.match(usageTable![0], /usageRequestTarget\(row\)/);
    assert.match(usageTable![0], /usageRequestSessionCell\(row, props\.onOpenSession\)/);
    assert.match(usageTable![0], /row\.kind === 'model' \? `\$\$\{\(row\.costUsd \?\? 0\)\.toFixed\(2\)\}` : '-'/);
    assert.match(src, /case 'model': return '模型'/);
    assert.match(src, /case 'tool': return '工具'/);
    assert.match(src, /return row\.kind === 'tool' \? row\.toolName \?\? row\.model : row\.model/);
    assert.match(src, /function usageRequestSessionCell/);
    assert.match(src, /onClick=\{\(\) => onOpenSession\(row\.sessionId\)\}/);
    assert.match(src, /打开 \{label\}/);
    assert.match(src, /function shortUsageSessionId/);
    assert.doesNotMatch(
      usageTable![0],
      /,\s*row\.kind\s*,/,
      'Usage request table must not render raw `model` / `tool` enums directly',
    );
  });

  it('wires usage diagnostics rows back to source sessions through the shell', async () => {
    const settingsSrc = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');
    const mainSrc = await readRepo('apps/desktop/src/renderer/main.tsx');

    assert.match(settingsSrc, /onOpenSession\?\(sessionId: string\): void/);
    assert.match(settingsSrc, /onOpenSession=\{props\.onOpenSession\}/);
    assert.match(mainSrc, /onOpenSession=\{\(sessionId\) => \{/);
    assert.match(
      mainSrc,
      /closeSettings\(\);[\s\S]*setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);[\s\S]*setActiveId\(sessionId\);/,
      'opening a session from Settings must switch the shell back to the chat surface before selecting it',
    );
  });
});
