/**
 * Per-kind preview switcher for the ArtifactPane. Routes by `record.kind`
 * and renders:
 *
 *   - `file`  → plain text via `readText`, monospace `<pre>`
 *   - `diff`  → unified diff via `readText`, line-tagged for add/del/hunk
 *   - `html`  → sandboxed `<iframe srcdoc>` with `sandbox="allow-scripts"`
 *               (NO `allow-same-origin`, `allow-top-navigation`,
 *               `allow-popups`, `allow-forms`, `allow-modals`). External
 *               links are counted via regex on `srcdoc` and reported in a
 *               status bar above the iframe — `<a href>` clicks are silently
 *               blocked by the sandbox (no `allow-popups`), so we tell the
 *               user up-front rather than letting them think the link
 *               "doesn't work".
 *   - `image` → `readBinary` → `<img src="data:…">` (MIME sniffed in main)
 *   - `pdf`   → `readBinary` → `<embed type="application/pdf">` with a
 *               fallback `<p>` instructing the user to open in Finder when
 *               the embed plugin is unavailable.
 *
 * Failure modes come back as a small `FailureCard` so the user
 * always sees a Chinese-language explanation of *why* the preview is empty
 * instead of a blank surface:
 *
 *   - `not_found` / `read_failed` → destructive ("路径可能已被外部删除")
 *   - `not_allowed`               → destructive ("路径检查未通过")
 *   - `too_large`                 → info, includes byte count + Finder hint
 *   - `deleted`                   → info ("此 artifact 已删除")
 *   - `unsupported_mime`          → info, binary only
 *
 * No component in this file ever assembles an absolute path: every read
 * goes through `window.maka.artifacts.readText` / `readBinary`.
 */
import { useEffect, useState } from 'react';
import type {
  ArtifactBinaryReadResult,
  ArtifactRecord,
  ArtifactTextReadResult,
} from '@maka/core';
import { cn, previewVariants, Spinner } from '@maka/ui';
import { RegistryArtifactPreview } from './artifact-preview-registry-shell';

export function ArtifactPreview(props: { record: ArtifactRecord; onShowInFolder?: () => void }) {
  const { record, onShowInFolder } = props;
  switch (record.kind) {
    case 'file':
      return <FilePreview record={record} />;
    case 'diff':
      return <DiffPreview record={record} />;
    case 'html':
      return <HtmlPreview record={record} />;
    case 'image':
      // PR-UI-RENDER-3a: route image previews through the typed
      // registry shell so the resolution path (mime match / ext
      // fallback / oversize / mime_disallowed) is testable + the
      // Unsupported fallback is consistent. file/diff/html/pdf stay
      // on the legacy path until their PR-RENDER-3b/c/d/e gates
      // land.
      return <RegistryArtifactPreview record={record} onShowInFolder={onShowInFolder} />;
    case 'pdf':
      return <PdfPreview record={record} />;
  }
}

// ---- text-backed previews --------------------------------------------------

function FilePreview(props: { record: ArtifactRecord }) {
  const result = useTextRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label="加载文件预览…" />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} />;
  return (
    <pre className="maka-artifact-preview-file maka-code">{result.value.text}</pre>
  );
}

function DiffPreview(props: { record: ArtifactRecord }) {
  const result = useTextRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label="加载 diff 预览…" />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} />;
  const lines = result.value.text.split('\n');
  return (
    <div className={cn('maka-artifact-preview-diff', previewVariants({ part: 'diff' }))} data-kind="file_diff">
      <pre className={previewVariants({ part: 'diff-body' })}>
        {lines.map((line, index) => (
          <span
            key={`${index}:${line.slice(0, 16)}`}
            className={previewVariants({ part: 'diff-line' })}
            data-line={diffLineKind(line)}
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function HtmlPreview(props: { record: ArtifactRecord }) {
  const result = useTextRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label="加载 HTML 预览…" />;
  if (!result.value.ok) return <TextFailureCard record={props.record} reason={result.value.reason} />;
  const srcdoc = result.value.text;
  // External links inside the sandboxed iframe (no
  // `allow-popups`) silently fail. We surface the count up-front so the user
  // isn't surprised when clicks do nothing. Regex deliberately permissive —
  // counts `<a … href=` regardless of whitespace / attribute order.
  const externalLinkCount = (srcdoc.match(/<a\s[^>]*href=/gi) ?? []).length;
  return (
    <div className="maka-artifact-preview-html">
      <div
        className="maka-artifact-preview-external-links-bar"
        // @kenji a11y gate #5: screen readers should announce "外链已禁用 · N
        // links" when the user lands on an HTML artifact. `role="status"`
        // plus `aria-live="polite"` makes the change get queued for AT
        // without interrupting whatever the user is currently doing.
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        此预览中已禁用外部链接 · {externalLinkCount} 个链接
      </div>
      <iframe
        className="maka-artifact-preview-html-iframe"
        title={`生成文件预览 · ${props.record.name}`}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
      />
    </div>
  );
}

// ---- binary-backed previews ------------------------------------------------

// PR-UI-RENDER-3a — the previous `ImagePreview` component was
// replaced by `RegistryArtifactPreview` from
// `./artifact-preview-registry-shell`. The replacement adds the
// typed registry resolution (mime_match / ext_fallback / oversize /
// mime_disallowed / no_mime_no_ext), the L2 base64 cap, and the
// Unsupported card with conditional "在 Finder 中打开" CTA.

function PdfPreview(props: { record: ArtifactRecord }) {
  const result = useBinaryRead(props.record.id);
  if (result.state === 'loading') return <PreviewLoading label="加载 PDF 预览…" />;
  if (!result.value.ok) return <BinaryFailureCard record={props.record} reason={result.value.reason} />;
  return (
    <div className="maka-artifact-preview-pdf">
      <embed
        type="application/pdf"
        src={`data:application/pdf;base64,${result.value.base64}`}
        width="100%"
        height="100%"
      />
      <p className="maka-artifact-preview-pdf-fallback">
        如果浏览器没有内置 PDF 渲染，请使用工具栏的「在 Finder 中打开」查看。
      </p>
    </div>
  );
}

// ---- shared affordances ----------------------------------------------------

function PreviewLoading(props: { label: string }) {
  return (
    <div className="maka-artifact-preview-loading" role="status" aria-live="polite">
      <Spinner className="maka-artifact-preview-spinner" aria-hidden="true" role="presentation" />
      <span>{props.label}</span>
    </div>
  );
}

function TextFailureCard(props: { record: ArtifactRecord; reason: TextFailureReason }) {
  const { tone, title, description } = failureCopyText(props.record, props.reason);
  return <FailureCard tone={tone} title={title} description={description} />;
}

function BinaryFailureCard(props: { record: ArtifactRecord; reason: BinaryFailureReason }) {
  const { tone, title, description } = failureCopyBinary(props.record, props.reason);
  return <FailureCard tone={tone} title={title} description={description} />;
}

function FailureCard(props: {
  tone: 'destructive' | 'info';
  title: string;
  description: string;
}) {
  return (
    <div className="maka-artifact-preview-fail" data-tone={props.tone} role="status">
      <div className="maka-artifact-preview-fail-title">{props.title}</div>
      <p className="maka-artifact-preview-fail-body">{props.description}</p>
    </div>
  );
}

// ---- failure-reason → copy -------------------------------------------------

type TextFailureReason = Extract<ArtifactTextReadResult, { ok: false }>['reason'];
type BinaryFailureReason = Extract<ArtifactBinaryReadResult, { ok: false }>['reason'];

interface FailureCopy {
  tone: 'destructive' | 'info';
  title: string;
  description: string;
}

function failureCopyText(record: ArtifactRecord, reason: TextFailureReason): FailureCopy {
  switch (reason) {
    case 'not_found':
    case 'read_failed':
      return {
        tone: 'destructive',
        title: '无法读取生成文件',
        description: '路径可能已被外部删除。请通过工具栏「在 Finder 中打开」检查文件位置。',
      };
    case 'not_allowed':
      return {
        tone: 'destructive',
        title: '无法读取生成文件',
        description: '路径检查未通过，文件已不在允许预览的生成文件目录内。',
      };
    case 'too_large':
      return {
        tone: 'info',
        title: '文件超出预览大小',
        description: `${record.sizeBytes} 字节超过文本预览阈值，请通过工具栏「在 Finder 中打开」查看完整内容。`,
      };
    case 'deleted':
      return {
        tone: 'info',
        title: '此生成文件已删除',
        description: '预览已停止。如需查看原文件请使用「在 Finder 中打开」。',
      };
  }
}

function failureCopyBinary(record: ArtifactRecord, reason: BinaryFailureReason): FailureCopy {
  if (reason === 'unsupported_mime') {
    return {
      tone: 'info',
      title: '不支持的文件类型',
      description: '该生成文件的 MIME 类型不在内联预览允许列表中。请使用工具栏「在 Finder 中打开」或「另存为」。',
    };
  }
  return failureCopyText(record, reason);
}

// ---- read hooks ------------------------------------------------------------

type AsyncReadState<T> = { state: 'loading' } | { state: 'ready'; value: T };

function useTextRead(artifactId: string): AsyncReadState<ArtifactTextReadResult> {
  const [state, setState] = useState<AsyncReadState<ArtifactTextReadResult>>({
    state: 'loading',
  });
  useEffect(() => {
    let disposed = false;
    setState({ state: 'loading' });
    window.maka.artifacts
      .readText(artifactId)
      .then((value) => {
        if (!disposed) setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Map IPC-level failures (preload throw, channel closed) onto the
        // contract enum so the FailureCard can render a consistent message
        // instead of leaking an Electron error string to the user.
        const message = error instanceof Error ? error.message : String(error);
        const reason: TextFailureReason = message.includes('not_allowed')
          ? 'not_allowed'
          : 'read_failed';
        setState({ state: 'ready', value: { ok: false, reason } });
      });
    return () => {
      disposed = true;
    };
  }, [artifactId]);
  return state;
}

function useBinaryRead(artifactId: string): AsyncReadState<ArtifactBinaryReadResult> {
  const [state, setState] = useState<AsyncReadState<ArtifactBinaryReadResult>>({
    state: 'loading',
  });
  useEffect(() => {
    let disposed = false;
    setState({ state: 'loading' });
    window.maka.artifacts
      .readBinary(artifactId)
      .then((value) => {
        if (!disposed) setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        const reason: BinaryFailureReason = message.includes('not_allowed')
          ? 'not_allowed'
          : 'read_failed';
        setState({ state: 'ready', value: { ok: false, reason } });
      });
    return () => {
      disposed = true;
    };
  }, [artifactId]);
  return state;
}
