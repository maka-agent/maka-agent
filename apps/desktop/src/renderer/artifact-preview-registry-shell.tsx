/**
 * PR-UI-RENDER-3a — renderer components consumed by the registry.
 *
 * Two components, both deliberately small:
 *
 *   - `UnsupportedArtifactPreview` — pure UI. Shows file metadata
 *     (name, MIME if known, size) and a brief reason copy keyed to
 *     `PreviewResolution.reason`. Optionally renders a real
 *     "在 Finder 中打开" button when the caller passes
 *     `onShowInFolder`. No prop = no button (NOT a disabled button —
 *     @kenji review @msg 9cf1ca7a says disabled buttons here would
 *     wrongly suggest "all unsupported items can be opened in
 *     Finder").
 *   - `ImageArtifactPreview` — loads the binary via
 *     `window.maka.artifacts.readBinary`, applies the L2 base64
 *     length cap from `exceedsImagePayloadCap` BEFORE decoding,
 *     and renders a `<img>` with `object-fit: contain` inside a
 *     bounded container. Loading / failure / oversize all fall
 *     back to the Unsupported component with a typed `reason`.
 *
 * No new IPC introduced — the components only call existing
 * `window.maka.artifacts.readBinary` (PR-UI-12) and reuse
 * `window.maka.app.openArtifactPath` via the caller's optional
 * `onShowInFolder` prop.
 */

import { useEffect, useState } from 'react';
import type { ArtifactRecord } from '@maka/core';
import { Button, Spinner } from '@maka/ui';
import {
  type ArtifactPreviewInput,
  type PreviewResolution,
  decideImageReadOutcome,
  formatPreviewSize,
  resolvePreviewKind,
} from '@maka/ui/artifact-preview-registry';

/**
 * Top-level dispatcher: classifies the record and renders the
 * appropriate component. The caller (currently
 * `artifact-preview.tsx`) only needs to call this for the `image`
 * record.kind; other kinds keep using the legacy preview switch.
 */
export function RegistryArtifactPreview(props: {
  record: ArtifactRecord;
  /** Optional: shows a real button when provided. Hidden otherwise. */
  onShowInFolder?: () => void;
}) {
  const input = toPreviewInput(props.record);
  const resolution = resolvePreviewKind(input);
  if (resolution.kind === 'image') {
    return <ImageArtifactPreview record={props.record} input={input} onShowInFolder={props.onShowInFolder} />;
  }
  return (
    <UnsupportedArtifactPreview
      input={input}
      reason={resolution.reason}
      onShowInFolder={props.onShowInFolder}
    />
  );
}

/**
 * Reason → user-facing copy. Keyed by `PreviewResolution.reason`
 * (the unsupported variant only). Adding a new reason variant in
 * the registry pure module forces TypeScript exhaustiveness here.
 */
function describeUnsupportedReason(
  reason: Extract<PreviewResolution, { kind: 'unsupported' }>['reason'],
): { title: string; description: string } {
  switch (reason) {
    case 'kind_disallowed':
      return {
        title: '当前预览暂不支持该类型',
        description: '此类生成文件不能在面板内直接预览。请使用工具栏「在 Finder 中打开」查看。',
      };
    case 'mime_disallowed':
      return {
        title: '格式暂不支持预览',
        description: '已识别到文件的 MIME 类型，但当前预览只支持 PNG / JPEG / GIF / WebP / AVIF。',
      };
    case 'no_mime_no_ext':
      return {
        title: '无法识别文件类型',
        description: '文件没有 MIME 元数据，扩展名也未匹配。请通过工具栏「在 Finder 中打开」查看。',
      };
    case 'oversize':
      return {
        title: '文件过大，暂不预览',
        description: '为避免在内存中加载大体积图片，超过 2 MB 的文件不在此处展开预览。',
      };
    case 'read_failed':
      // PR-UI-RENDER-3a fixup (@kenji review @msg 5fa6f6a5) — distinct
      // copy for IPC / read failures. v1 collapsed this into
      // `kind_disallowed` which told the user "format unsupported"
      // when the real cause was a missing / unreadable file.
      return {
        title: '加载预览失败',
        description: '无法读取文件内容（可能已被删除、移动或权限不足）。请通过工具栏「在 Finder 中打开」检查文件。',
      };
    default: {
      const _exhaustive: never = reason;
      return { title: '暂不支持的预览', description: String(_exhaustive) };
    }
  }
}

/**
 * Renders metadata + reason text. NEVER renders `relativePath` or
 * any absolute path (the input shape doesn't even carry path data).
 */
export function UnsupportedArtifactPreview(props: {
  input: ArtifactPreviewInput;
  reason: Extract<PreviewResolution, { kind: 'unsupported' }>['reason'];
  onShowInFolder?: () => void;
}) {
  const copy = describeUnsupportedReason(props.reason);
  return (
    <div className="maka-artifact-preview-unsupported" data-reason={props.reason} role="status">
      <div className="maka-artifact-preview-unsupported-title">{copy.title}</div>
      <p className="maka-artifact-preview-unsupported-body">{copy.description}</p>
      <dl className="maka-artifact-preview-unsupported-meta">
        <div>
          <dt>名称</dt>
          <dd>{props.input.name || '(未命名)'}</dd>
        </div>
        {props.input.mimeType && (
          <div>
            <dt>类型</dt>
            <dd>{props.input.mimeType}</dd>
          </div>
        )}
        <div>
          <dt>大小</dt>
          <dd>{formatPreviewSize(props.input.sizeBytes)}</dd>
        </div>
      </dl>
      {/* @kenji review @msg 9cf1ca7a — only render the button when a
          real handler is provided. We deliberately do NOT render a
          disabled button here: a disabled button suggests the action
          is available "eventually", which is misleading for surfaces
          that have no path-open IPC. */}
      {props.onShowInFolder && (
        <Button
          type="button"
          variant="secondary"
          className="maka-artifact-preview-unsupported-cta"
          onClick={props.onShowInFolder}
        >
          在 Finder 中打开
        </Button>
      )}
    </div>
  );
}

/**
 * Loads the image via existing `readBinary` IPC, enforces L2 base64
 * length cap before any decode, and renders inside a bounded
 * container with `object-fit: contain` so an unexpectedly large
 * intrinsic size can't break the chat / pane layout.
 *
 * Critical invariant (@kenji review @msg 5fa6f6a5):
 *   - The post-load L2 decision (`decideImageReadOutcome`) runs
 *     INSIDE the async, BEFORE `setState`. The hook's state union
 *     therefore holds either a `loading` placeholder, an `image`
 *     branch carrying the verified base64, OR an `unsupported`
 *     branch that carries NO base64. A 10MB oversize payload never
 *     enters React state / DevTools snapshot.
 *   - The component below is intentionally a thin switch over the
 *     hook state — it never sees the raw `ArtifactBinaryReadResult`.
 */
function ImageArtifactPreview(props: {
  record: ArtifactRecord;
  input: ArtifactPreviewInput;
  onShowInFolder?: () => void;
}) {
  const result = useImagePreviewLoad(props.record.id);
  if (result.state === 'loading') {
    return (
      <div className="maka-artifact-preview-loading" role="status" aria-live="polite">
        <Spinner className="maka-artifact-preview-spinner" aria-hidden="true" role="presentation" />
        <span>加载图片预览…</span>
      </div>
    );
  }
  if (result.state === 'unsupported') {
    return (
      <UnsupportedArtifactPreview
        input={props.input}
        reason={result.reason}
        onShowInFolder={props.onShowInFolder}
      />
    );
  }
  // result.state === 'image' — exhaustiveness check below.
  return (
    <div className="maka-artifact-preview-image">
      <img
        alt={props.record.name}
        src={`data:${result.safeMime};base64,${result.base64}`}
      />
    </div>
  );
}

function toPreviewInput(record: ArtifactRecord): ArtifactPreviewInput {
  return {
    name: record.name,
    kind: record.kind,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  };
}

/**
 * Hook state for the image preview load. Closed union — the
 * `unsupported` branch DELIBERATELY does NOT carry `base64`.
 *
 * @kenji review @msg 5fa6f6a5: the v1 of this hook held a raw
 * `ArtifactBinaryReadResult` (which carries base64 in its `ok: true`
 * branch). That meant a 10MB oversize payload could land in React
 * state / DevTools before the L2 cap rejected it for rendering. The
 * fix replaces the broad union with this closed three-way one and
 * runs the L2 decision INSIDE the async, so the only `base64` that
 * ever reaches `setState` is one that has already passed
 * `decideImageReadOutcome` (cap + MIME re-validation).
 *
 * Source/test gate (locked by `artifact-preview-registry.test.ts`):
 * the `unsupported` branch type signature MUST NOT include `base64`.
 * Future contributors who try to expand the state to "carry base64
 * alongside the unsupported outcome for debugging" must update both
 * this type AND the kenji-gate test (which fails closed).
 */
type ImagePreviewLoadState =
  | { state: 'loading' }
  | { state: 'image'; safeMime: string; base64: string }
  | {
      state: 'unsupported';
      reason: Extract<PreviewResolution, { kind: 'unsupported' }>['reason'];
    };

function useImagePreviewLoad(artifactId: string): ImagePreviewLoadState {
  const [state, setState] = useState<ImagePreviewLoadState>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ state: 'loading' });
    void (async () => {
      try {
        const raw = await window.maka.artifacts.readBinary(artifactId);
        if (cancelled) return;
        // L2 decision happens HERE, before `setState`. The pure helper
        // returns `{ kind: 'image', safeMime, base64 }` only when both
        // the base64 length cap AND the MIME re-validation pass; the
        // unsupported branch never carries base64. So `setState` only
        // receives the post-decision shape.
        const outcome = decideImageReadOutcome(raw);
        if (outcome.kind === 'image') {
          setState({ state: 'image', safeMime: outcome.safeMime, base64: outcome.base64 });
        } else {
          setState({ state: 'unsupported', reason: outcome.reason });
        }
      } catch {
        if (cancelled) return;
        // Catch path also never carries base64 — same invariant.
        setState({ state: 'unsupported', reason: 'read_failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId]);
  return state;
}
