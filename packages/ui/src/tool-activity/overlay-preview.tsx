import { type ToolResultContent } from '@maka/core';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { ExploreAgentPreview, SubagentPreview } from './agent-preview.js';
import { FileDiffPreview } from './file-diff-preview.js';
import { OfficeDocumentPreview } from './office-document-preview.js';
import { capLines, formatUserVisibleToolText } from './preview-utils.js';
import { RiveWorkflowPreview } from './rive-workflow-preview.js';
import { TerminalPreview } from './terminal-preview.js';
import { WebSearchErrorPreview, WebSearchPreview } from './web-search-preview.js';

/**
 * Renders a ToolResultContent payload with kind-specific presentation:
 * - `file_diff`: line-level red/green diff coloring
 * - `terminal`: stdout + stderr split with exit-code badge + stderr in
 *   destructive tone
 * - `office_document`: Office adapter stdout/stderr/diagnostic cards
 * - `explore_agent`: bounded read-only subagent findings
 * - `subagent`: foreground child-agent run summary
 * - `json`: pretty-printed in a code block
 * - `text` / others: plain `<pre>` fallback
 *
 * All variants are height-bounded by the `@maka/ui` previewVariants `overlay`
 * part (the retired `.maka-overlay-preview` base) to keep kilobyte outputs from
 * pushing the composer off-screen.
 */
export function OverlayPreview(props: { content: ToolResultContent }) {
  const { content } = props;

  if (content.kind === 'file_diff') {
    return <FileDiffPreview diff={content.diff} paths={content.paths} />;
  }

  if (content.kind === 'web_search') {
    return (
      <WebSearchPreview query={content.query} provider={content.provider} rows={content.rows} />
    );
  }

  if (content.kind === 'web_search_error') {
    return (
      <WebSearchErrorPreview
        query={content.query}
        provider={content.provider}
        reason={content.reason}
        message={content.message}
        credentialSource={content.credentialSource}
      />
    );
  }

  if (content.kind === 'terminal') {
    return (
      <TerminalPreview
        cwd={content.cwd}
        cmd={content.cmd}
        exitCode={content.exitCode}
        stdout={content.stdout}
        stderr={content.stderr}
      />
    );
  }

  if (content.kind === 'office_document') {
    return <OfficeDocumentPreview result={content} />;
  }

  if (content.kind === 'explore_agent') {
    return <ExploreAgentPreview result={content} />;
  }

  if (content.kind === 'subagent') {
    return <SubagentPreview result={content} />;
  }

  if (content.kind === 'rive_workflow') {
    return <RiveWorkflowPreview result={content} />;
  }

  if (content.kind === 'json') {
    let body: string;
    try {
      body = JSON.stringify(content.value, null, 2);
    } catch {
      body = String(content.value);
    }
    // JSON shouldn't contain secrets persisted by Maka (settings + telemetry
    // are sanitized at write-time), but apply the renderer redactor as a
    // second-layer defense in case a tool returned raw provider response.
    return <pre className={previewVariants({ part: 'overlay' })} data-kind="json">{formatUserVisibleToolText(redactSecrets(body))}</pre>;
  }

  if (content.kind === 'text') {
    const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(content.text)));
    return (
      <pre className={previewVariants({ part: 'overlay' })} data-kind="text">
        {body}
        {capped > 0 && `\n\n… 已隐藏 ${capped} 行`}
      </pre>
    );
  }

  // file_write / image / summary / unknown — show a compact descriptor so the
  // user knows what kind landed without dumping binary or storage refs.
  return (
    <pre className={previewVariants({ part: 'overlay' })} data-kind={content.kind}>
      [{content.kind}]
    </pre>
  );
}
