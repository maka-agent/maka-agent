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

    assert.match(
      src,
      /<header className="maka-chat-header">[\s\S]*?<\/header>\s*\{\(props\.sessionStatusBadge \|\| props\.connectionAlert \|\| props\.eventStreamAlert\) && \(/,
      'status badges should render after the header, not inside the header toolbar row',
    );
    assert.match(
      src,
      /<div className="maka-chat-status-cluster">[\s\S]*?<\/div>\s*\)\}\s*\{isLocalSimulationBackend && \(/,
      'status badges should stay before the fake-backend banner so normal flow reserves vertical space before first content',
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
