// Electron harness: prove the Maka-owned cursor overlay floats over the REAL
// desktop, click-through and without stealing focus, using the actual
// createCursorOverlayController. Drives scripted moves/clicks, then cleans up.
//
// Run (after build:main + build-cursor-overlay): electron scripts/cursor-overlay-demo.mjs
import { app, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCursorOverlayController } from '../apps/desktop/dist/main/computer-use/cursor-overlay-window.js';

const here = dirname(fileURLToPath(import.meta.url));
const distOverlay = join(here, '..', 'apps', 'desktop', 'dist', 'overlay');

app.on('window-all-closed', () => { /* keep alive; we quit manually */ });

app.whenReady().then(() => {
  const ctrl = createCursorOverlayController({
    preloadPath: join(distOverlay, 'cursor-overlay-preload.cjs'),
    htmlPath: join(distOverlay, 'cursor-overlay.html'),
  });
  const session = 'demo-run-1';
  ctrl.ensure(session);

  const b = screen.getPrimaryDisplay().bounds;
  const STEPS = 12;
  let i = 0;
  const step = () => {
    const x = b.x + 160 + Math.random() * (b.width - 320);
    const y = b.y + 160 + Math.random() * (b.height - 320);
    const kind = i % 2 === 0 ? 'click' : 'move';
    ctrl.move({ actionId: `a${i}`, sessionId: session, screenX: x, screenY: y, kind });
    // eslint-disable-next-line no-console
    console.log(`step ${i}: ${kind} → ${Math.round(x)},${Math.round(y)}`);
    i += 1;
    if (i >= STEPS) {
      setTimeout(() => { ctrl.destroyAll(); app.quit(); }, 2200);
      return;
    }
    setTimeout(step, 1500);
  };
  setTimeout(step, 700);
});
