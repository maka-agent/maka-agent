/**
 * Heavy markdown rendering pipeline — split out of `markdown.tsx` so the
 * initial renderer chunk doesn't have to parse `react-markdown` +
 * `remark-gfm` / `remark-breaks` + `rehype-highlight` (which bundles the
 * highlight.js grammars) before React can mount the chat shell.
 *
 * This module is loaded on demand via `React.lazy` from `markdown.tsx`
 * the first time a message actually needs to be rendered. On a fresh
 * launch with no active session, none of this code is parsed at all,
 * which keeps "open window → see the app shell" snappy.
 *
 * Everything security-sensitive (the `maka://` URI allowlist, the safe-
 * scheme external-link gate, the broken-link inline errors) lives here
 * alongside the `Markdown` body it overrides `react-markdown` with —
 * see `markdown.tsx` for the trust-boundary rationale.
 */

import { useContext, type ReactNode } from 'react';
import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from './icons.js';

import { Button as UiButton } from './ui.js';
import {
  isMakaUriCandidate,
  isSafeExternalScheme,
  parseMakaUri,
} from './maka-uri.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { MakaUriContext } from './markdown.js';
import { streamFadeRehypePlugin, type StreamFade } from './stream-fade.js';

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const MARKDOWN_REHYPE_PLUGINS = [
  // `detect: true` lets hljs guess the language when the fence didn't tag one;
  // `ignoreMissing: true` keeps bogus tags like ```mermaid from throwing.
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
] as const;

export function MarkdownBody(props: { text: string; streamFade?: StreamFade }) {
  const rehypePlugins = props.streamFade
    ? [...MARKDOWN_REHYPE_PLUGINS, streamFadeRehypePlugin(props.streamFade)]
    : MARKDOWN_REHYPE_PLUGINS;
  return (
    <ReactMarkdown
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={rehypePlugins as never}
      components={{
        // PR-UI-RENDER-2: route `maka://` links through the internal
        // URI parser so the assistant can drop in-app navigation
        // affordances ("用账号登录 Settings → Account"). The parser
        // is a strict allowlist; anything outside (`maka://tool/`,
        // `maka://auth/`, malformed sections) renders as a
        // non-clickable broken-link inline error. NEVER falls back
        // to `openExternal` — internal-link routing must not become
        // a hidden external-URL escape.
        a: ({ children, href, ...rest }) => (
          <MarkdownLink href={href} {...rest}>
            {children}
          </MarkdownLink>
        ),
        // Inline `code` keeps the bubble's foreground color; only block code
        // gets the framed treatment via `pre > code` in CSS.
        code: ({ children, className, ...rest }) => (
          <code {...rest} className={className}>
            {children}
          </code>
        ),
        // Wrap block code with a language pill header + copy affordance.
        // The pill is from an external design reference (40-markdown-deep §7a) — surfaces the
        // detected language so users can verify hljs got it right.
        pre: ({ children, ...rest }) => <CodeBlock {...rest}>{children}</CodeBlock>,
        // #618 item 5: the horizontal scroller for over-wide tables lives on
        // a wrapper div. Scrolling on the table itself requires
        // `display: block`, which stops the element generating a table box —
        // Chromium then drops the implicit table/row/cell ARIA roles and
        // screen readers lose table navigation. TABLE-A11Y-SEMANTICS-0.
        table: ({ children, ...rest }) => (
          <div className="maka-table-scroll">
            <table {...rest}>{children}</table>
          </div>
        ),
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

/**
 * PR-UI-RENDER-2 — Markdown link router. See `markdown.tsx` for the
 * full routing contract; this implementation is byte-for-byte the same
 * as the original, just relocated so the eager `markdown.tsx` only
 * holds the context + lazy wrapper.
 */
function MarkdownLink(props: {
  href?: string;
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const { href, children, ...rest } = props;
  const dispatch = useContext(MakaUriContext);

  if (typeof href === 'string' && isMakaUriCandidate(href)) {
    const dest = parseMakaUri(href);
    if (dest && dispatch) {
      return (
        <button
          type="button"
          className="maka-markdown-link maka-markdown-link-internal"
          data-maka-uri-kind={dest.kind}
          onClick={() => dispatch(dest)}
        >
          {children}
        </button>
      );
    }
    return (
      <span
        className="maka-markdown-link maka-markdown-link-broken"
        data-reason="internal-invalid"
        title="内部链接无效"
        aria-label="内部链接无效"
      >
        {children}
      </span>
    );
  }

  if (typeof href === 'string' && isSafeExternalScheme(href)) {
    return (
      <a {...rest} href={href} className="maka-markdown-link maka-markdown-link-external" target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <span
      className="maka-markdown-link maka-markdown-link-broken"
      data-reason="unsafe-scheme"
      title="链接不安全"
      aria-label="链接不安全"
    >
      {children}
    </span>
  );
}

function CodeBlock({ children, ...rest }: { children?: ReactNode }) {
  const code = isElementWithClassName(children) ? children : null;
  const lang = code?.props.className?.match(/language-([A-Za-z0-9_+-]+)/)?.[1]?.toLowerCase();
  const copyFeedback = useClipboardCopyFeedback(1400, { redact: false });
  const copyPhase = copyFeedback.phaseFor('code');
  const copyPending = copyPhase === 'pending';
  const copied = copyPhase === 'copied';

  async function copy() {
    const text = collectCodeText(code?.props.children);
    await copyFeedback.copy('code', text);
  }

  return (
    <div className="maka-code-block">
      <div className="maka-code-block-header">
        <span className="maka-code-block-lang">{lang ?? 'code'}</span>
        <UiButton
          type="button"
          className="maka-code-block-copy"
          variant="quiet"
          size="icon-sm"
          onClick={() => void copy()}
          aria-label={copyPhase === 'pending' ? '复制代码中' : copyPhase === 'copied' ? '已复制代码' : copyPhase === 'failed' ? '复制代码失败' : '复制代码'}
          aria-busy={copyPending ? 'true' : undefined}
          disabled={copyPending}
          data-copied={copied}
          data-copy-feedback={copyPhase ?? undefined}
          data-pending={copyPending ? 'true' : undefined}
        >
          {copied
            ? <Check size={12} aria-hidden="true" />
            : <Copy size={12} aria-hidden="true" />}
        </UiButton>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

function isElementWithClassName(node: ReactNode): node is React.ReactElement<{ className?: string; children?: ReactNode }> {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collectCodeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(collectCodeText).join('');
  if (isElementWithClassName(children)) return collectCodeText(children.props.children);
  return '';
}