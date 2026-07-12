// Overlay preload — ONE-WAY main→renderer bridge. Exposes only receive
// callbacks (ipcRenderer.on); the overlay can never send/invoke back to main,
// so it cannot initiate coordinates or inject input (Path 18 S15 stays intact).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cursorOverlay', {
  onMove: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:move', (_e, payload) => cb(payload));
  },
  onComplete: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:complete', (_e, payload) => cb(payload));
  },
  onReset: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:reset', (_e, payload) => cb(payload));
  },
});
