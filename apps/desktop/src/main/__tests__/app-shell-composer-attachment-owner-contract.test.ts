import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps/desktop/src/renderer');

describe('AppShell composer attachment ownership', () => {
  it('keeps attachment state and picker IPC behind one owner', async () => {
    const [shell, owner] = await Promise.all([
      readFile(resolve(RENDERER_ROOT, 'app-shell.tsx'), 'utf8'),
      readFile(resolve(RENDERER_ROOT, 'use-app-shell-composer-attachments.ts'), 'utf8'),
    ]);

    assert.match(shell, /useAppShellComposerAttachments\(\{ draftKey: attachmentDraftKey, toastApi \}\)/);
    assert.doesNotMatch(shell, /useState<PendingByKey|window\.maka\.attachments\.pickFiles/);
    assert.match(owner, /useState<PendingByKey<PendingAttachment>>/);
    assert.match(owner, /window\.maka\.attachments\.pickFiles\(\)/);
    assert.match(owner, /const ownerKey = options\.draftKey/);
    assert.match(owner, /clearSubmittedAttachments/);
    assert.match(owner, /removePendingItems\(map, ownerKey, submitted\)/);
  });

  it('keeps chat send and compact routing in the composition layer', async () => {
    const [shell, owner] = await Promise.all([
      readFile(resolve(RENDERER_ROOT, 'app-shell.tsx'), 'utf8'),
      readFile(resolve(RENDERER_ROOT, 'use-app-shell-composer-attachments.ts'), 'utf8'),
    ]);

    assert.match(shell, /const ok = await send\(text, pending\)/);
    assert.match(
      shell,
      /const sessionId = activeIdRef\.current;[\s\S]*window\.maka\.sessions\.compact\(sessionId\)/,
    );
    assert.doesNotMatch(owner, /sessions\.send|sessions\.compact/);
  });
});
