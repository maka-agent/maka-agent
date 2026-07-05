import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AttachmentRef, SessionSummary, StoredMessage } from '@maka/core';
import { ChatView } from '@maka/ui';

const REPO_ROOT = process.cwd().endsWith('apps/desktop')
  ? resolve(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('attachment frontend contract', () => {
  it('global file-drop navigation guard lets explicit renderer import targets handle drag/drop', async () => {
    const mainWindow = await readRepo('apps/desktop/src/main/main-window.ts');
    const composer = await readRepo('packages/ui/src/composer.tsx');
    const onboarding = await readRepo('apps/desktop/src/renderer/OnboardingHero.tsx');

    assert.match(
      mainWindow,
      /closest\('\[data-maka-file-drop-target="true"\]'\)/,
      'BrowserWindow capture guard must skip declared file-drop targets so React drop handlers can ingest files',
    );
    assert.match(
      composer,
      /data-maka-file-drop-target=\{canAcceptDroppedFiles\(\) \? 'true' : undefined\}/,
      'Composer must declare itself as a file-drop target only while attachment import is available',
    );
    assert.match(
      onboarding,
      /data-maka-file-drop-target=\{canAcceptDroppedTextFiles\(\) \? 'true' : undefined\}/,
      'Onboarding quick chat must keep its text-file drop target compatible with the same guard',
    );
  });

  it('renderer attachment import preserves clipboard blobs that have no filesystem path', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');

    assert.match(
      preload,
      /async ingestFiles\(sessionId: string, files: File\[\]\): Promise<AttachmentRef\[\]>/,
      'preload must expose an async file-ingest helper that can read File bytes when Electron has no path',
    );
    assert.match(
      preload,
      /webUtils\.getPathForFile\(file\)[\s\S]*file\.arrayBuffer\(\)/,
      'preload ingestFiles must preserve path-backed files and fall back to File.arrayBuffer() for pasted blobs',
    );
    assert.match(
      globals,
      /ingestFiles\(sessionId: string, files: File\[\]\): Promise<import\('@maka\/core'\)\.AttachmentRef\[\]>/,
      'renderer global types must expose the blob-capable attachment API',
    );
    assert.match(
      appShell,
      /await window\.maka\.attachments\.ingestFiles\(sessionId, files\)/,
      'composer drop/paste must call the blob-capable API instead of reducing Files to paths first',
    );
    assert.doesNotMatch(
      appShell,
      /pathsForFiles\(files\)/,
      'composer drop/paste must not silently drop pasted image blobs with empty filesystem paths',
    );
  });

  it('new-chat composer can start attachment import before a session exists', async () => {
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globals = await readRepo('apps/desktop/src/global.d.ts');
    const appShell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');

    assert.match(
      preload,
      /pickFiles\(\): Promise<[\s\S]*files: \{ path: string; mimeType\?: string; size: number \}\[\]/,
      'preload must expose a pick-only API so new chat can avoid creating an empty session when the user cancels',
    );
    assert.match(
      globals,
      /pickFiles\(\): Promise<[\s\S]*files: \{ path: string; mimeType\?: string; size: number \}\[\]/,
      'renderer global types must expose the pick-only attachment API',
    );
    assert.match(
      appShell,
      /async function ensureAttachmentSession\(\): Promise<string>/,
      'new chat attachment import must create a session only after the user has provided files',
    );
    assert.match(
      appShell,
      /const result = await window\.maka\.attachments\.pickFiles\(\);[\s\S]*const sessionId = await ensureAttachmentSession\(\);[\s\S]*window\.maka\.attachments\.ingestPaths\(sessionId, result\.files\)/,
      'the + button must pick files before creating/using a session, then ingest the chosen paths',
    );
    assert.match(
      appShell,
      /onPickAttachments=\{pickAttachments\}/,
      'Composer must receive the + attachment handler on the new-chat surface too',
    );
    assert.match(
      appShell,
      /onAttachFilePaths=\{attachFilePaths\}/,
      'Composer must receive drop/paste attachment handlers on the new-chat surface too',
    );
  });

  it('generated-files pane excludes user-uploaded attachments', async () => {
    const artifactPane = await readRepo('apps/desktop/src/renderer/artifact-pane.tsx');

    assert.match(
      artifactPane,
      /record\.source !== 'user_upload'/,
      'ArtifactPane is labeled generated files and must not list user-uploaded attachment snapshots',
    );
  });

  it('passes selected model vision capability to the runtime attachment renderer', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');

    assert.match(
      main,
      /function modelSupportsVision\(connection: LlmConnection, model: string\): boolean/,
      'main must derive image-input support from the selected model before wiring AiSdkBackend',
    );
    assert.match(
      main,
      /resolveModelVisionSupport\(connection\.providerType, connection\.models, model\)/,
      'vision support must consult stored capabilities, then fall back to in-repo metadata for bare-id models (provider /models responses do not return image capability)',
    );
    assert.match(
      main,
      /const supportsVision = modelSupportsVision\(connection, model\)/,
      'main must evaluate the selected model vision capability in the ai-sdk backend path',
    );
    assert.match(
      main,
      /\bsupportsVision,\s*\n/,
      'AiSdkBackend must always receive the resolved vision support (true = send image parts, false = fallback notice)',
    );
  });

  it('renders user image attachments inside the chat turn stream', () => {
    const attachment: AttachmentRef = {
      kind: 'image',
      name: 'clipboard.png',
      mimeType: 'image/png',
      bytes: 4,
      ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' },
    };
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '看这张图', attachments: [attachment] },
    ];
    const activeSession: SessionSummary = {
      id: 's1',
      name: 'Attachment check',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'fixture',
      model: 'fixture-model',
      permissionMode: 'ask',
    };

    const markup = renderToStaticMarkup(createElement(ChatView, {
      messages,
      streamingText: '',
      tools: [],
      activeSession,
      mode: 'sessions',
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-user-attachments/);
    assert.match(markup, /maka-user-attachment-thumb-pending/);
  });
});
