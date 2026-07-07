import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
          status: 'failed',
          exitCode: 1,
          stdout: numberedLines('stdout', 501),
          stderr: `stderr ${SECRET}`,
          stdoutTruncated: false,
          stderrTruncated: false,
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
          action: `run ${SECRET}`,
          command: ['rive', 'run'],
          ids: {
            workflowRunId: 'wf_123',
            schedulerRunId: 'sch_123',
            rootWorkNodeId: 'root_123',
          },
          state: `failed ${SECRET}`,
          summary: `workflow failed ${SECRET}`,
          nodes: [{ title: `node ${SECRET}`, state: 'failed', runner: `runner=${SECRET}` }],
          stderrTail: `tail ${SECRET}`,
          error: { reason: 'rive_failed', message: `failed ${SECRET}` },
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
    // #546 PR6: the text-kind body reuses the prose layer instead of the mono
    // <pre> overlay — the container carries .maka-prose so the prose element
    // rules (typography, links, code pills, break-word, edge trims) apply.
    // (renderToStaticMarkup can't await the lazy markdown pipeline, so the
    // markup here is the Suspense plain-text fallback; the wiring contract —
    // prose-classed container, no raw <pre> — is what this locks.)
    assert.match(text, /class="[^"]*maka-prose[^"]*"[^>]*data-kind="text"|data-kind="text"[^>]*class="[^"]*maka-prose[^"]*"/, 'text-kind tool results must render inside a .maka-prose container (#546 PR6)');
    assert.doesNotMatch(text, /<pre/, 'text-kind tool results are markdown prose now, not a mono <pre> dump');

    const json = renderPreview({ kind: 'json', value: { token: SECRET, ok: true } });
    assert.match(json, /data-kind="json"/);
    assert.match(json, /&quot;ok&quot;: true/);
    assert.doesNotMatch(json, new RegExp(SECRET));

    const fileWrite = renderPreview({ kind: 'file_write', path: 'out.txt', bytes: 12 });
    assert.match(fileWrite, /data-kind="file_write"/);
    assert.match(fileWrite, /\[file_write\]/);
    assert.doesNotMatch(fileWrite, /out\.txt/);
  });

  it('entity-encoded secrets cannot ride the markdown decode past redaction (codex review P1)', async () => {
    // `sk&#45;…` never matches the redactor (it sees no `sk-`), but micromark
    // decodes character references during parse, so prose rendering would
    // show the live secret. The projection decodes numeric references the
    // same way (and approximates named ones — `&hyphen;` renders a glyph
    // visually identical to `-`), then re-runs the redactor; a hit degrades
    // to the literal <pre> path, display parity with the old preview. A
    // blanket `&`→`&amp;` escape is NOT an acceptable defense: CommonMark
    // keeps character references literal inside code spans/blocks, so it
    // corrupts `a && b` into `a &amp;&amp; b` (codex review round 5 P2 —
    // covered by the ampersand-fidelity test below).
    const uiDist = (rel: string) => pathToFileURL(join(process.cwd(), '../../packages/ui/dist', rel)).href;
    const { toolTextPreviewPlan } = await import(uiDist('tool-activity/preview-utils.js')) as {
      toolTextPreviewPlan(text: string): { markdown: string } | { plain: string };
    };
    for (const encoded of [
      'sk&#45;1234567890abcdefghi',
      'sk&#x2D;1234567890abcdefghi',
      'sk&hyphen;1234567890abcdefghi',
    ]) {
      const plan = toolTextPreviewPlan(`key: ${encoded}`);
      assert.ok('plain' in plan, `${JSON.stringify(encoded)} must degrade to the literal plain path — markdown would decode the reference into the clear`);
      assert.match((plan as { plain: string }).plain, /sk&/, 'the degraded text shows the encoded form literally, matching the old <pre> behavior');
    }
  });

  it('ampersands reach markdown byte-identical — code spans keep && (codex review round 5 P2)', async () => {
    // CommonMark treats character references as literal text inside code
    // spans and code blocks, so a blanket `&`→`&amp;` escape (the round-2
    // defense this replaced) displayed `cmd && next` as `cmd &amp;&amp;
    // next` and corrupted the code-copy payload. Entity-decode safety now
    // lives in the projection degrade instead, so benign ampersands must
    // pass through untouched.
    const uiDist = (rel: string) => pathToFileURL(join(process.cwd(), '../../packages/ui/dist', rel)).href;
    const { toolTextPreviewPlan } = await import(uiDist('tool-activity/preview-utils.js')) as {
      toolTextPreviewPlan(text: string): { markdown: string } | { plain: string };
    };
    const plan = toolTextPreviewPlan('run `make lint && make test` before pushing — AT&T style');
    assert.ok('markdown' in plan, 'benign text with ampersands keeps the prose path');
    const markdown = (plan as { markdown: string }).markdown;
    assert.ok(markdown.includes('`make lint && make test`'), 'code-span ampersands must survive byte-identical');
    assert.ok(!markdown.includes('&amp;'), 'the markdown path must not blanket-escape ampersands');
  });

  it('markdown-consumed punctuation cannot reassemble a secret in the clear (codex review P1 round 2)', async () => {
    // Backslash escapes (`sk\-…`), emphasis delimiters (`sk*-*…`), and link
    // syntax all make markdown REMOVE punctuation from the rendered text,
    // reassembling a secret the raw-text redactor never matched. These
    // can't be neutralized one-by-one without an arms race, so the preview
    // degrades: if stripping markdown-consumed characters exposes redactable
    // content, the result renders through the literal <pre> path instead.
    const uiDist = (rel: string) => pathToFileURL(join(process.cwd(), '../../packages/ui/dist', rel)).href;
    const { toolTextPreviewPlan } = await import(uiDist('tool-activity/preview-utils.js')) as {
      toolTextPreviewPlan(text: string): { markdown: string } | { plain: string };
    };
    for (const encoded of [
      'sk\\-1234567890abcdefghi',
      'sk*-*1234567890abcdefghi',
      '[sk-](https://x)1234567890abcdefghi',
      // Reference-style link: the `[.]` label content vanishes from the
      // rendered text just like an inline destination (codex review round 4).
      '[sk-][.]1234567890abcdefghi\n\n[.]: https://x',
    ]) {
      const plan = toolTextPreviewPlan(`key: ${encoded}`);
      assert.ok('plain' in plan, `${JSON.stringify(encoded)} must degrade to the literal plain path — markdown rendering would strip the punctuation and reassemble the secret`);
    }
    // Plain prose keeps the markdown path.
    const prose = toolTextPreviewPlan('# heading\n\nnormal *emphasis* and a [link](https://example.com)');
    assert.ok('markdown' in prose, 'benign markdown must keep the prose path');

    // End-to-end: the degraded result must render literally, not through markdown.
    const markup = renderPreview({ kind: 'text', text: 'key: sk\\-1234567890abcdefghi' });
    assert.match(markup, /<pre[^>]*data-kind="text"/, 'secret-shaped text must fall back to the literal <pre> overlay');
    assert.doesNotMatch(markup, new RegExp(SECRET), 'the live secret must never appear');
  });

  it('redacts ExploreAgent copy payloads before they reach the clipboard', async () => {
    const uiModuleUrl = pathToFileURL(join(process.cwd(), '../../packages/ui/dist/tool-activity/agent-preview.js')).href;
    const { buildExploreAgentCopyPayloads } = await import(uiModuleUrl) as {
      buildExploreAgentCopyPayloads(result: Extract<ToolResultContent, { kind: 'explore_agent' }>): Record<string, string>;
    };
    const payloads = buildExploreAgentCopyPayloads({
      kind: 'explore_agent',
      ok: true,
      partial: true,
      terminalStatus: 'completed_empty',
      mode: 'read_only',
      objective: `Find ${SECRET}`,
      roots: [`packages/${SECRET}`],
      queries: [`query ${SECRET}`],
      ignoredPaths: [`ignored/${SECRET}`],
      stoppingCondition: `stop ${SECRET}`,
      limitReasons: ['file_budget'],
      filesDiscovered: 4,
      filesInspected: 3,
      filesSkipped: 1,
      bytesRead: 4096,
      durationMs: 1250,
      progress: [`progress ${SECRET}`],
      recentEvents: [{ type: 'read', at: 1250, message: `read ${SECRET}` }],
      evidence: [{ type: 'match', path: `src/${SECRET}.ts`, line: 7, label: `label ${SECRET}` }],
      summary: `summary ${SECRET}`,
      report: `report ${SECRET}`,
      candidateFiles: [{ path: `src/candidate-${SECRET}.ts`, score: 0.8, reasons: [`path contains "${SECRET}"`] }],
      matches: [{ path: `src/match-${SECRET}.ts`, line: 9, query: `query ${SECRET}`, snippet: `snippet ${SECRET}` }],
      notes: [`note ${SECRET}`],
    });

    for (const key of ['summary', 'process', 'evidence', 'report', 'candidate', 'matches', 'continuation'] as const) {
      assert.equal(typeof payloads[key], 'string', `${key} payload must exist`);
      assert.doesNotMatch(payloads[key], new RegExp(SECRET), `${key} payload must redact runtime secrets`);
    }
    assert.match(payloads.summary, /<redacted>/);
    assert.match(payloads.matches, /<redacted>/);
    assert.match(payloads.continuation, /<redacted>/);
  });
});

function renderPreview(content: ToolResultContent): string {
  return renderToStaticMarkup(createElement(OverlayHost, { content, onClose: () => {} }));
}

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}
