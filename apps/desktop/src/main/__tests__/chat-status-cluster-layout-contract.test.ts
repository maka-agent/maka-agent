import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `${selector} rule should exist`);
  return match[1] ?? '';
}

describe('chat status cluster layout contract', () => {
  it('keeps alert/status badges in flow between the header and first chat content', async () => {
    const src = await readRepo('packages/ui/src/chat-view.tsx');

    // The cluster div is ALWAYS mounted (streaming-settle polish): it
    // collapses via the CSS `:empty` height transition instead of conditional
    // mount/unmount, which used to snap the conversation column up by the
    // badge-row height the frame a run completed. The badges inside stay
    // conditional.
    assert.match(
      src,
      /<\/header>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="maka-chat-status-cluster">/,
      'status badges should render after the header, not inside the header toolbar row',
    );
    assert.match(
      src,
      /<div className="maka-chat-status-cluster">\s*\{props\.sessionStatusBadge && /,
      'the cluster div must be unconditionally mounted with badges conditional INSIDE (the :empty transition depends on it)',
    );
    assert.match(
      src,
      /<div className="maka-chat-status-cluster">[\s\S]*?<\/div>\s*\{isLocalSimulationBackend && \(/,
      'status badges should stay before the fake-backend banner so normal flow reserves vertical space before first content',
    );
  });

  it('collapses via :empty with tokenized height/opacity transition instead of unmount', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.maka-chat-status-cluster');
    assert.match(body, /interpolate-size:\s*allow-keywords/, 'height auto↔0 transition needs interpolate-size');
    assert.match(body, /transition:[\s\S]*?height var\(--duration-large\)/, 'height must transition on a duration token');
    const emptyBody = ruleBody(css, '.maka-chat-status-cluster:empty');
    assert.match(emptyBody, /height:\s*0/);
    assert.match(emptyBody, /opacity:\s*0/);
  });

  it('reserves the footer placeholder for every live turn, not only text answers', async () => {
    // Three-way review (ChatGPT P2): a settled turn ALWAYS mounts a footer
    // (deriveTurnFooterActions yields regenerate/branch from TurnStatus alone;
    // materialize emits a timeline item for a step's thinking even with empty
    // text), so a thinking-only turn settles WITH a footer. The live footer
    // placeholder must live inside the `streamingText || thinkingText` section
    // and render unconditionally there — never re-narrowed to streamingText —
    // so it reserves the footer box for every live turn.
    //
    // Groundwork only: this locks the reserved box. It makes the swap
    // height-neutral where the live section is held to settle (text turns, via
    // the draining handshake). The textless / thinking-only completion path is
    // still non-atomic (clears live before the committed footer mounts); that
    // is tracked in the single-render-path convergence (#642), not asserted
    // here.
    const src = await readRepo('packages/ui/src/chat-view.tsx');
    assert.match(
      src,
      /Unconditional \(not gated on streamingText\)[\s\S]*?\*\/\}\s*<div aria-hidden="true" className="mt-0\.5 h-8" \/>/,
      'the footer placeholder must render unconditionally inside the live section (covers thinking-only turns)',
    );
    assert.doesNotMatch(
      src,
      /\{props\.streamingText && <div aria-hidden="true" className="mt-0\.5 h-8" \/>\}/,
      'the placeholder must not be re-gated on streamingText alone — that misses thinking-only settle',
    );
  });

  it('uses an in-flow wrapping row instead of absolute positioning', async () => {
    const css = await readRendererContractCss();
    const body = ruleBody(css, '.maka-chat-status-cluster');

    assert.doesNotMatch(
      body,
      /position:\s*absolute/,
      'wrapped multi-badge rows must not be absolute-positioned over first-screen chat content',
    );
    assert.doesNotMatch(
      body,
      /\btop:\s*calc\(var\(--maka-workspace-top-actions-bottom\)/,
      'the status row should no longer depend on toolbar bottom geometry',
    );
    assert.match(body, /flex-wrap:\s*wrap/);
    assert.match(body, /justify-content:\s*flex-end/);
  });
});
