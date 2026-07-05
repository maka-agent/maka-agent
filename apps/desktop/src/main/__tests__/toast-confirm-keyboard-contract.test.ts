import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const REPO_ROOT = join(process.cwd(), '..', '..');
const TOAST_SOURCE = join(REPO_ROOT, 'packages/ui/src/toast.tsx');

describe('toast.confirm keyboard safety contract', () => {
  it('queues overlapping confirm requests instead of overwriting the active dialog', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const providerBlock = src.match(/export function ToastProvider[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(providerBlock, /const activeConfirmRef = useRef<PendingConfirm \| null>\(null\)/);
    assert.match(providerBlock, /const confirmQueueRef = useRef<PendingConfirm\[\]>\(\[\]\)/);
    assert.match(
      providerBlock,
      /if \(activeConfirmRef\.current\) \{\s*confirmQueueRef\.current\.push\(request\);\s*return;\s*\}/,
      'a second confirm request must be queued while a dialog is active',
    );
    assert.doesNotMatch(
      providerBlock,
      /setConfirmState\(\{\s*\.\.\.input,\s*resolve\s*\}\)/,
      'a second confirm request must not overwrite and strand the active Promise',
    );
  });

  it('settles one confirm at a time and advances the queued dialog', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const providerBlock = src.match(/export function ToastProvider[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(providerBlock, /const current = activeConfirmRef\.current;/);
    assert.match(providerBlock, /if \(!current\) return;/);
    assert.match(providerBlock, /activeConfirmRef\.current = null;\s*current\.resolve\(result\);/);
    assert.match(providerBlock, /const next = confirmQueueRef\.current\.shift\(\) \?\? null;/);
    assert.match(providerBlock, /activeConfirmRef\.current = next;\s*setConfirmState\(next\);/);
  });

  it('cancels active and queued confirm requests when the provider unmounts', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const providerBlock = src.match(/export function ToastProvider[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(providerBlock, /activeConfirmRef\.current\?\.resolve\(false\);/);
    assert.match(providerBlock, /for \(const pending of confirmQueueRef\.current\) \{\s*pending\.resolve\(false\);\s*\}/);
    assert.match(providerBlock, /confirmQueueRef\.current = \[\];/);
  });

  it('does not globally map Enter to destructive confirmation', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const confirmBlock = src.match(/function ConfirmDialog[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(confirmBlock, /AlertDialogRoot/, 'confirm must remain an accessible alertdialog (Base UI AlertDialog auto-sets role)');
    assert.doesNotMatch(
      confirmBlock,
      /addEventListener\('keydown'[\s\S]*event\.key === 'Enter'[\s\S]*onResolve\(true\)/,
      'Enter must not be captured globally because Enter on the focused cancel button would confirm',
    );
    assert.doesNotMatch(
      confirmBlock,
      /event\.key === 'Enter'[\s\S]*preventDefault\(\)[\s\S]*onResolve\(true\)/,
      'ConfirmDialog must let focused buttons handle Enter/Space natively',
    );
  });

  it('initially focuses the cancel button so destructive dialogs are reversible by default', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const confirmBlock = src.match(/function ConfirmDialog[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(confirmBlock, /const cancelRef = useRef<HTMLButtonElement>\(null\)/);
    assert.match(confirmBlock, /initialFocus=\{cancelRef\}/, 'Base UI AlertDialog focuses the cancel button via initialFocus');
    assert.match(confirmBlock, /<Button\s+ref=\{cancelRef\}[\s\S]*onClick=\{\(\) => props\.onResolve\(false\)\}/);
  });

  it('remounts ConfirmDialog on queue advance so initialFocus re-targets the cancel button', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const providerBlock = src.match(/export function ToastProvider[\s\S]*?\n\}/)?.[0] ?? '';

    // PendingConfirm carries a stable id so the second confirm in a queue
    // remounts ConfirmDialog (key change). Without this, AlertDialog's
    // uncontrolled `defaultOpen` + `initialFocus` only fire on the first
    // mount, leaving focus on the confirm button → Enter mis-confirms a
    // dangerous op (PR6 review P1).
    assert.match(providerBlock, /const request: PendingConfirm = \{ id: `c\$\{\+\+idSeed\.current\}`, \.\.\.input, resolve \}/);
    assert.match(
      providerBlock,
      /<ConfirmDialog key=\{confirmState\.id\} request=\{confirmState\}/,
      'ConfirmDialog must key on confirmState.id so queue advance remounts the dialog and re-runs initialFocus',
    );
  });
});
