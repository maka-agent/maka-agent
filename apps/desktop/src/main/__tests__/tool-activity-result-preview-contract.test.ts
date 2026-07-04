import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolResultContent } from '@maka/core';
import { OverlayHost } from '@maka/ui';

const SECRET = 'sk-1234567890abcdefghi';

describe('ToolActivity result preview contract', () => {
  it('renders structured result kinds as cards before the generic JSON fallback', () => {
    const cases: ReadonlyArray<{ kind: ToolResultContent['kind']; content: ToolResultContent; expected: RegExp[] }> = [
      {
        kind: 'file_diff',
        content: {
          kind: 'file_diff',
          paths: ['packages/ui/src/tool-activity.tsx'],
          diff: ['diff --git a/a b/a', '@@ -1 +1 @@', `-${SECRET}`, '+visible line'].join('\n'),
        },
        expected: [/data-kind="file_diff"/, /data-line="del"/, /data-line="add"/],
      },
      {
        kind: 'web_search',
        content: {
          kind: 'web_search',
          provider: 'tavily',
          query: `maka ${SECRET}`,
          rows: [{
            title: `Search result ${SECRET}`,
            url: `https://example.com/result?api_key=${SECRET}`,
            snippet: `Snippet ${SECRET}`,
            source: 'example',
          }],
        },
        expected: [/data-kind="web_search"/, /tavily · 1 条结果/, /api_key=&lt;redacted&gt;/],
      },
      {
        kind: 'web_search_error',
        content: {
          kind: 'web_search_error',
          ok: false,
          provider: 'tavily',
          query: 'maka',
          reason: 'invalid_credentials',
          message: `provider rejected ${SECRET}`,
          credentialSource: 'saved',
        },
        expected: [/data-kind="web_search_error"/, /搜索失败/, /请在 设置 · 联网搜索 中更新 Tavily key。/],
      },
      {
        kind: 'terminal',
        content: {
          kind: 'terminal',
          cwd: '/tmp/maka',
          cmd: `npm test --api-key=${SECRET}`,
          exitCode: 1,
          stdout: numberedLines('stdout', 501),
          stderr: `stderr ${SECRET}`,
        },
        expected: [/data-kind="terminal"/, /退出码 1/, /stdout 已隐藏 1 行/, /复制研读提示/],
      },
      {
        kind: 'office_document',
        content: {
          kind: 'office_document',
          ok: false,
          operation: 'set-prop',
          path: 'report.docx',
          args: ['set-prop', `token=${SECRET}`],
          stdout: '',
          stderr: `failed ${SECRET}`,
          reason: 'officecli_failed',
          message: '',
        },
        expected: [/data-kind="office_document"/, /诊断：操作失败/, /report\.docx/],
      },
      {
        kind: 'rive_workflow',
        content: {
          kind: 'rive_workflow',
          ok: false,
          action: 'run',
          command: ['rive', 'run'],
          ids: { workflowRunId: 'wf_123', schedulerRunId: 'sch_123', rootWorkNodeId: 'root_123' },
          summary: 'workflow failed',
          stderrTail: `tail ${SECRET}`,
          error: { reason: 'rive_failed', message: 'failed' },
        },
        expected: [/data-kind="rive_workflow"/, /workflow_run: wf_123/, /Rive workflow failed/],
      },
      {
        kind: 'explore_agent',
        content: {
          kind: 'explore_agent',
          ok: true,
          mode: 'read_only',
          objective: `Find preview contract ${SECRET}`,
          roots: ['packages/ui/src'],
          queries: ['ToolResultPreview'],
          filesInspected: 2,
          filesSkipped: 0,
          bytesRead: 1024,
          progress: ['scanned previews'],
          candidateFiles: [{ path: 'packages/ui/src/tool-activity.tsx', score: 0.9, reasons: ['content match'] }],
          matches: [{ path: 'packages/ui/src/tool-activity.tsx', line: 12, query: 'ToolResultPreview', snippet: 'routes results' }],
          notes: ['bounded preview'],
          summary: 'structured preview exists',
        },
        expected: [/data-kind="explore_agent"/, /Find preview contract/, /structured preview exists/],
      },
      {
        kind: 'subagent',
        content: {
          kind: 'subagent',
          agentName: `Research Agent ${SECRET}`,
          turnId: 'turn-secret-123',
          status: 'completed',
          permissionMode: 'explore',
          summary: `Mapped preview path ${SECRET}`,
          artifactIds: ['artifact-secret-1'],
        },
        expected: [/data-kind="subagent"/, /Research Agent/, /结果摘要/],
      },
    ];

    for (const item of cases) {
      const markup = renderPreview(item.content);
      for (const expected of item.expected) {
        assert.match(markup, expected, `${item.kind} should render its structured preview`);
      }
      assert.doesNotMatch(markup, new RegExp(SECRET), `${item.kind} preview must redact runtime secrets`);
      assert.doesNotMatch(markup, /data-kind="json"/, `${item.kind} preview must not fall through to raw JSON`);
    }
  });

  it('keeps bounded text and compact unknown-kind fallbacks', () => {
    const text = renderPreview({ kind: 'text', text: numberedLines('line', 501) });
    assert.match(text, /data-kind="text"/);
    assert.match(text, /已隐藏 1 行/);

    const json = renderPreview({ kind: 'json', value: { token: SECRET, ok: true } });
    assert.match(json, /data-kind="json"/);
    assert.match(json, /&quot;ok&quot;: true/);
    assert.doesNotMatch(json, new RegExp(SECRET));

    const fileWrite = renderPreview({ kind: 'file_write', path: 'out.txt', bytes: 12 });
    assert.match(fileWrite, /data-kind="file_write"/);
    assert.match(fileWrite, /\[file_write\]/);
    assert.doesNotMatch(fileWrite, /out\.txt/);
  });
});

function renderPreview(content: ToolResultContent): string {
  return renderToStaticMarkup(createElement(OverlayHost, { content, onClose: () => {} }));
}

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}
