// Overlay preload. Main owns all coordinates and actions. Renderer may send only
// a fixed presentation-phase acknowledgement keyed by the action id.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cursorOverlay', {
  onMove: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:move', (_e, payload) => cb(payload));
  },
  onReset: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:reset', (_e, payload) => cb(payload));
  },
  onComplete: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:complete', (_e, payload) => cb(payload));
  },
  onCancel: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:cancel', (_e, payload) => cb(payload));
  },
  reportPresentationPhase: (
    sessionId: string,
    generation: number,
    actionId: string,
    phase: 'readyForInteraction' | 'finished',
  ): void => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (!Number.isInteger(generation) || generation < 1) return;
    if (typeof actionId !== 'string' || actionId.length === 0) return;
    if (phase !== 'readyForInteraction' && phase !== 'finished') return;
    ipcRenderer.send('overlay:presentation-phase', {
      sessionId,
      generation,
      actionId,
      phase,
    });
  },
});
