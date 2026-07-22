import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnyPermissionRequestEvent } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { PermissionPrompt } from '../permission-dialog.js';

function render(request: AnyPermissionRequestEvent): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <PermissionPrompt
        request={request}
        onRespond={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );
}

describe('permission dialog closed review', () => {
  test('renders the reviewed command and trusted cwd', () => {
    const markup = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-1',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      review: { kind: 'command', command: 'npm test', cwd: '/workspace/maka-agent' },
      rememberForTurnAllowed: true,
    });

    assert.match(markup, /npm test/);
    assert.match(markup, /\/workspace\/maka-agent/);
    assert.match(markup, /本轮记住/);
    assert.match(markup, /<section[^>]*role="region"/);
    assert.doesNotMatch(markup, /role="dialog"/);
    assert.match(markup, />停止<\/button>/);
    assert.match(markup, />拒绝操作<\/button>/);
  });

  test('renders one-shot additional permission paths from their dedicated review', () => {
    const markup = render({
      type: 'permission_request',
      kind: 'additional_permissions',
      id: 'event-2',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-2',
      toolUseId: 'tool-2',
      toolName: 'Write',
      category: 'file_write',
      reason: 'additional_permissions',
      review: {
        kind: 'additional_permissions',
        cwd: '/workspace/maka-agent',
        paths: [{ path: '/tmp/report.json', access: 'write', scope: 'exact' }],
        networkEnabled: false,
      },
      risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
      alsoApprovesToolExecution: false,
      availableDecisions: ['allow_once', 'deny'],
    });

    assert.match(markup, /\/tmp\/report\.json/);
    assert.match(markup, /仅此路径/);
    assert.match(markup, /允许这一次/);
    assert.doesNotMatch(markup, /本轮记住/);
  });

  test('redacts reviewed command and path values before rendering', () => {
    const command = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-3',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-3',
      toolUseId: 'tool-3',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      review: {
        kind: 'command',
        command: 'curl -H "Authorization: Bearer sk-live-secret-token" https://example.test',
        cwd: '/workspace/maka-agent',
      },
      rememberForTurnAllowed: true,
    });
    const path = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-4',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-4',
      toolUseId: 'tool-4',
      toolName: 'Write',
      category: 'file_write',
      reason: 'file_write',
      review: {
        kind: 'path',
        operation: 'write',
        path: '/tmp/sk-ant-test-secret-token-12345.txt',
        cwd: '/workspace/maka-agent',
      },
      rememberForTurnAllowed: true,
    });

    assert.doesNotMatch(command, /sk-live-secret-token/);
    assert.match(command, /Authorization: Bearer/);
    assert.doesNotMatch(path, /sk-ant-test-secret-token-12345/);
  });

  test('offers details only when the closed review contains inspectable stdin data', () => {
    const stdin = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-5',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-5',
      toolUseId: 'tool-5',
      toolName: 'WriteStdin',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      review: {
        kind: 'stdin',
        ref: 'maka://runtime/background-tasks/pty-1',
        input: { text: 'npm test\r', bytes: 9 },
        size: { cols: 80, rows: 24 },
      },
      rememberForTurnAllowed: false,
    });
    const command = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-6',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-6',
      toolUseId: 'tool-6',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      review: { kind: 'command', command: 'npm test', cwd: '/workspace/maka-agent' },
      rememberForTurnAllowed: true,
    });

    assert.match(stdin, /查看输入/);
    assert.match(stdin, /输入共 9 字节/);
    assert.match(stdin, /目标尺寸 80x24/);
    assert.doesNotMatch(command, /查看详情|查看输入/);
  });

  test('renders an Office edit through the shared closed path review', () => {
    const markup = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-7',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-7',
      toolUseId: 'tool-7',
      toolName: 'OfficeDocumentEdit',
      category: 'file_write',
      reason: 'file_write',
      review: {
        kind: 'path',
        operation: 'edit',
        path: 'reports/quarterly.docx',
        cwd: '/workspace/maka-agent',
      },
      rememberForTurnAllowed: true,
    });

    assert.match(markup, /允许编辑 Office 文档？/);
    assert.match(markup, /reports\/quarterly\.docx/);
    assert.doesNotMatch(markup, /\bprops\b|\btarget\b|\boperation\b/);
  });

  test('renders only aggregate swarm permission details', () => {
    const markup = render({
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'event-8',
      turnId: 'turn-1',
      ts: Date.now(),
      requestId: 'request-8',
      toolUseId: 'tool-8',
      toolName: 'agent_swarm',
      category: 'subagent',
      reason: 'custom',
      review: {
        kind: 'agent',
        operation: 'swarm',
        itemCount: 3,
        resumeCount: 1,
        concurrency: 2,
        profiles: ['local_read', 'web_research'],
        writeBack: ['summary'],
        isolation: ['same_workspace', 'worktree'],
      },
      rememberForTurnAllowed: false,
    });

    assert.match(markup, /启动 3 个子代理任务/);
    assert.match(markup, /并发 2/);
    assert.match(markup, /续跑 1 个/);
    assert.match(markup, /local_read, web_research/);
    assert.doesNotMatch(markup, /本轮记住/);
  });
});
