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

  it('preserves a manual expansion through a permission attention cycle', () => {
    const running: ToolActivityItem = {
      toolUseId: 'tool-permission',
      toolName: 'Bash',
      status: 'running',
      args: { command: 'npm test' },
    };
    const waiting: ToolActivityItem = {
      ...running,
      status: 'waiting_permission',
    };
    const expanded = setToolDisclosureOpen(
      createToolDisclosureState(deriveToolActivityPresentation(running)),
      true,
    );
    const duringPermission = syncToolDisclosureState(
      expanded,
      deriveToolActivityPresentation(waiting),
    );

    assert.deepEqual(
      syncToolDisclosureState(duringPermission, deriveToolActivityPresentation(running)),
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
    // Body still carries the failed stream text; no transport counts.
    assert.match(markup, /failed/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /已截断|输出已截断/);
  });

  it('renders expanded terminal output as one quiet panel without diagnostic chrome', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-terminal-panel',
        toolName: 'Bash',
        intent: '跑测试',
        status: 'errored',
        args: { command: 'npm run -w @maka/ui test' },
        result: {
          kind: 'terminal',
          cwd: '/tmp/maka',
          cmd: 'npm run -w @maka/ui test',
          status: 'failed',
          exitCode: 1,
          stdout: 'packages/ui ok\n',
          stderr: 'Error: boom\n',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));

    // Command without shell prompt; no cwd / success-style exit badge bar.
    assert.match(markup, /npm run -w @maka\/ui test/);
    assert.doesNotMatch(markup, /\$\s*npm run -w @maka\/ui test/);
    assert.doesNotMatch(markup, /\/tmp\/maka/);
    assert.doesNotMatch(markup, /实时输出/);
    // Failure note, not a permanent exit-code chrome row for successes.
    assert.match(markup, /失败 · 退出码 1|失败.*退出码 1/);
    assert.match(markup, /Error: boom/);
    // Unified panel surface (Codex-like well).
    assert.match(markup, /bg-\[var\(--foreground-3\)\]|data-slot="tool-output"/);
    // Tool output body uses base 13px, not caption 11px.
    assert.match(markup, /font-size-base/);
    // No always-on copy control on the output well (error banner may still copy).
    assert.doesNotMatch(markup, /复制研读提示/);
  });

  it('keeps live tool output in the same quiet panel language when open', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-live-panel',
        toolName: 'Bash',
        intent: '检查结构',
        status: 'waiting_permission',
        args: { command: 'Get-ChildItem -Depth 1' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'packages\n', redacted: false, createdAt: 1 },
        ],
        outputTruncated: true,
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /Get-ChildItem -Depth 1/);
    assert.doesNotMatch(markup, /\$\s*Get-ChildItem/);
    assert.doesNotMatch(markup, /实时输出/);
    assert.match(markup, /packages/);
    assert.match(markup, /已截断|输出已截断/);
    assert.match(markup, /bg-\[var\(--foreground-3\)\]|data-slot="tool-output"/);
    assert.match(markup, /max-h-64/);
  });

  it('renders Read as path + file text, not tool-call/result JSON', () => {
    // waiting_permission opens the panel without the error banner (which would
    // otherwise stringify the JSON result for copy).
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-read',
        toolName: 'Read',
        activityKind: 'read',
        intent: '读取 tool-runtime',
        status: 'waiting_permission',
        args: { path: 'packages/runtime/src/tool-runtime.ts', limit: 100 },
        result: {
          kind: 'json',
          value: {
            content: 'import type {\n  SessionEvent,\n  ToolOutputStream,\n} from \'@maka/core/events\';\n',
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /packages\/runtime\/src\/tool-runtime\.ts/);
    assert.match(markup, /SessionEvent/);
    assert.match(markup, /ToolOutputStream/);
    assert.doesNotMatch(markup, /&quot;path&quot;\s*:|"path"\s*:/);
    assert.doesNotMatch(markup, /&quot;limit&quot;\s*:|"limit"\s*:/);
    assert.doesNotMatch(markup, /&quot;content&quot;\s*:|"content"\s*:/);
    assert.doesNotMatch(markup, /import type \{\\n/);
  });

  it('renders Grep as pattern + match lines, not raw JSON', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-grep',
        toolName: 'Grep',
        activityKind: 'search',
        intent: '搜索 ToolOutputStream',
        status: 'waiting_permission',
        args: { pattern: 'ToolOutputStream', path: 'packages/ui/src' },
        result: {
          kind: 'json',
          value: {
            matches: [
              'packages/ui/src/tool-activity.tsx:10:function ToolOutputStream',
              'packages/ui/src/tool-activity.tsx:20:  chunks',
            ],
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /ToolOutputStream/);
    assert.match(markup, /packages\/ui\/src\/tool-activity\.tsx:10/);
    assert.doesNotMatch(markup, /&quot;pattern&quot;\s*:|"pattern"\s*:/);
    assert.doesNotMatch(markup, /&quot;matches&quot;\s*:|"matches"\s*:/);
  });

  it('never dumps pretty JSON for an arbitrary tool result object', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-custom',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { target: 'packages/ui', depth: 2 },
        result: {
          kind: 'json',
          value: {
            ok: true,
            notes: 'looks fine',
            detail: 'line one\nline two',
          },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /packages\/ui|target: packages\/ui/);
    assert.match(markup, /looks fine|notes:/);
    assert.match(markup, /line one/);
    assert.doesNotMatch(markup, /\{\s*&quot;ok&quot;/);
    assert.doesNotMatch(markup, /line one\\nline two/);
  });

  it('redacts credential-bearing property names in quiet key/value output', () => {
    const secret = 'sk-1234567890abcdefghi';
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-secret-key',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { [`api_key=${secret}`]: true },
        result: {
          kind: 'json',
          value: { nested: { [`token=${secret}`]: 'ok' } },
        },
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, new RegExp(secret));
    assert.match(markup, /redacted|api_key|&lt;redacted&gt;|ok/i);
  });

  it('redacts short secrets under sensitive keys like password', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-password',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { password: 'correct-horse' },
        result: {
          kind: 'json',
          value: { token: 'short-secret', ok: true },
        },
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, /correct-horse/);
    assert.doesNotMatch(markup, /short-secret/);
    assert.match(markup, /redacted|password|token/i);
  });

  it('redacts secrets embedded in property names', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-password-key',
        toolName: 'CustomInspect',
        status: 'waiting_permission',
        args: { 'password=correct-horse': true },
        result: { kind: 'json', value: { ok: true } },
      } satisfies ToolActivityItem],
    }));

    assert.doesNotMatch(markup, /correct-horse/);
    assert.match(markup, /password=&lt;redacted&gt;|password=&lt;redacted&gt;|password=&lt;redacted&gt;|password=<redacted>|redacted/i);
  });

  it('redacts secrets in keys that use colon or space separators', () => {
    for (const key of [
      'password: correct-horse',
      'password correct-horse',
      'token: short-secret',
      'Authorization: Bearer SENTINEL_TOKEN',
      'password: correct horse',
      // Multi-word key names + bare auth= payloads
      'api key: correct horse',
      'private key: gamma delta',
      'auth=correct horse',
      'auth: short secret',
      'access token: alpha beta',
    ]) {
      const markup = renderToStaticMarkup(createElement(ToolActivity, {
        items: [{
          toolUseId: `tool-key-${key}`,
          toolName: 'CustomInspect',
          status: 'waiting_permission',
          args: { [key]: true },
          result: { kind: 'json', value: { ok: true } },
        } satisfies ToolActivityItem],
      }));
      assert.doesNotMatch(
        markup,
        /correct-horse|short-secret|SENTINEL_TOKEN|\bhorse\b|gamma|delta|alpha|beta/,
      );
      assert.match(markup, /redacted/i);
    }
  });

  it('keeps error diagnostics when a list field is also present', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-mixed',
        toolName: 'CustomInspect',
        status: 'errored',
        args: {},
        result: {
          kind: 'json',
          value: { results: [], error: 'permission denied', ok: false },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /permission denied/);
    assert.match(markup, /ok:\s*false|未完成|false/);
  });

  it('keeps the Write path when args and result headlines match', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-write',
        toolName: 'Write',
        activityKind: 'edit',
        status: 'waiting_permission',
        args: { path: 'packages/ui/src/secret.ts', content: 'x' },
        result: {
          kind: 'json',
          value: { ok: true, path: 'packages/ui/src/secret.ts', bytes: 1 },
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /packages\/ui\/src\/secret\.ts/);
    assert.match(markup, /已完成|1 B/);
  });

  it('renders shell_run with command, status, and captured output', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-shell-run',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
        args: { command: 'npm test' },
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-1',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          stdout: 'starting\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /npm test/);
    assert.match(markup, /后台运行中|background-tasks/);
    assert.match(markup, /starting/);
    assert.doesNotMatch(markup, /\[shell_run\]/);
    // One quiet well only — not nested shared + shell_run panels.
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
    const commands = markup.match(/npm test/g) ?? [];
    assert.equal(commands.length, 1);
  });

  it('keeps pre-yield live output when shell_run lands with empty streams', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-shell-run-empty',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: 'starting-live-output\n', redacted: true, createdAt: 1 },
        ],
        outputTruncated: true,
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-empty',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /starting-live-output/);
    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    assert.doesNotMatch(markup, /尚无输出/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('keeps redacted/truncated meta when live chunks are empty bodies', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-shell-run-empty-meta',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'waiting_permission',
        args: { command: 'npm test' },
        outputChunks: [
          { seq: 1, stream: 'stdout', text: '', redacted: true, createdAt: 1 },
        ],
        outputTruncated: true,
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-meta',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm test',
          startedAt: 1,
          updatedAt: 2,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));

    assert.match(markup, /已脱敏/);
    assert.match(markup, /输出已截断/);
    const panels = markup.match(/data-slot="tool-output"/g) ?? [];
    assert.equal(panels.length, 1);
  });

  it('does not wrap subagent preview in an outer quiet panel', () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-subagent',
        toolName: 'Subagent',
        status: 'waiting_permission',
        args: {},
        result: {
          kind: 'subagent',
          agentName: 'Review Agent',
          turnId: 'turn',
          status: 'completed',
          permissionMode: 'ask',
          summary: 'done',
          artifactIds: [],
          startedAt: 1,
          durationMs: 1,
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(markup, /data-kind="subagent"/);
    // Subagent owns its surface — no outer tool-output well wrapping it.
    assert.equal((markup.match(/data-slot="tool-output"/g) ?? []).length, 0);
  });

  it('surfaces terminal cancel and runtime truncation flags', () => {
    const cancelled = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-cancel',
        toolName: 'Bash',
        status: 'interrupted',
        args: { command: 'sleep 99' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'sleep 99',
          status: 'cancelled',
          exitCode: 130,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(cancelled, /已取消/);
    assert.doesNotMatch(cancelled, /失败 · 退出码 130/);
    assert.doesNotMatch(cancelled, /工具调用失败/);
    // Outer status must not say 失败 either.
    assert.doesNotMatch(cancelled, />失败</);

    const cancelledTrow = renderToStaticMarkup(createElement(ToolTrow, {
      items: [{
        toolUseId: 'tool-cancel-trow',
        toolName: 'Bash',
        activityKind: 'command',
        status: 'interrupted',
        args: { command: 'sleep 99' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'sleep 99',
          status: 'cancelled',
          exitCode: 130,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(cancelledTrow, /运行 1 条命令/);
    assert.doesNotMatch(cancelledTrow, /1 个失败/);

    const truncated = renderToStaticMarkup(createElement(ToolActivity, {
      items: [{
        toolUseId: 'tool-trunc',
        toolName: 'Bash',
        status: 'waiting_permission',
        args: { command: 'run' },
        result: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'run',
          status: 'completed',
          exitCode: 0,
          stdout: 'tail only',
          stderr: '',
          stdoutTruncated: true,
          stderrTruncated: false,
        },
      } satisfies ToolActivityItem],
    }));
    assert.match(truncated, /tail only/);
    assert.match(truncated, /输出已截断/);
  });
});
