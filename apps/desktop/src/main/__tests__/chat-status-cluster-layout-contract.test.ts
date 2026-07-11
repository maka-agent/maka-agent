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

  it('reserves the footer placeholder inside the tail turn while it streams (#642)', async () => {
    // #642 single render path: there is no longer a separate
    // `.maka-turn-streaming` section — the in-flight answer rides the tail
    // turn's own TurnView. While that turn is live (`props.liveStreaming`),
    // its footer slot is a reserved-height placeholder (same `mt-0.5 h-8` box
    // the real footer occupies), NOT the actionable TurnFooterActions: the
    // live tail's derived status is `completed`, so a real footer would offer
    // a clickable regenerate/branch on a still-streaming answer. Reserving the
    // box keeps the live→settled swap height-neutral on the one node.
    const src = await readRepo('packages/ui/src/chat-view.tsx');
    assert.doesNotMatch(
      src,
      /maka-turn-streaming/,
      'the separate streaming section must be gone — the tail turn owns the live answer',
    );
    assert.match(
      src,
      /props\.liveStreaming \? \([\s\S]*?<div aria-hidden="true" className="mt-0\.5 h-8" \/>[\s\S]*?\) : \(/,
      'while live, the tail turn footer slot must be the reserved-height placeholder, not the real footer',
    );
    // The assistant answer block mounts for a live tail turn even with an empty
    // committed timeline (thinking-only / textless), so its answer never
    // disappears at settle.
    assert.match(
      src,
      /const showAssistantMessage = turn\.timeline\.length > 0 \|\| !!props\.liveStreaming;/,
      'the assistant Message must mount when the turn has timeline content OR is the live tail',
    );
    // Terminal liveTurn is evidence-only (empty shell_run chunks). Footer must
    // stay actionable — do not treat terminal projection as in-flight stream,
    // and do not let lagging wait indicators re-lock the footer over it.
    assert.match(
      src,
      /liveInFlight = !!\(props\.liveTurn && !props\.liveTurn\.terminal\)/,
      'only non-terminal liveTurn blocks the footer as streaming',
    );
    assert.match(
      src,
      /streamingActive = liveInFlight \|\| \(!props\.liveTurn\?\.terminal && waitIndicators\)/,
      'terminal evidence outranks delayed processing/continuing indicators',
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
