import type { KeyboardEvent, PointerEvent } from 'react';
import {
  clampSessionListWidth,
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from './session-list-layout.js';
import {
  clampSessionWorkbarWidth,
  SESSION_WORKBAR_MAX_WIDTH,
  SESSION_WORKBAR_MIN_WIDTH,
} from './session-workbar-layout.js';

type NumberStateUpdater = (next: number) => void;

export interface AppShellLayoutActions {
  startColumnResize(event: PointerEvent<HTMLDivElement>): void;
  onResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  startWorkbarResize(event: PointerEvent<HTMLDivElement>): void;
  onWorkbarResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}

export function createAppShellLayoutActions(deps: {
  sessionListCollapsed: boolean;
  sessionListWidth: number;
  setSessionListWidth: NumberStateUpdater;
  workbarCollapsed: boolean;
  workbarWidth: number;
  setWorkbarWidth: NumberStateUpdater;
}): AppShellLayoutActions {
  const {
    sessionListCollapsed,
    sessionListWidth,
    setSessionListWidth,
    workbarCollapsed,
    workbarWidth,
    setWorkbarWidth,
  } = deps;

  function startColumnResize(event: PointerEvent<HTMLDivElement>) {
    if (sessionListCollapsed) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture can fail if the target is detached mid-drag */
    }
    const startX = event.clientX;
    const start = sessionListWidth;
    document.body.classList.add('isResizingColumns');
    let cleaned = false;

    function onMove(moveEvent: globalThis.PointerEvent) {
      const delta = moveEvent.clientX - startX;
      setSessionListWidth(clampSessionListWidth(start + delta));
    }

    function cleanupResize() {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove('isResizingColumns');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanupResize);
      window.removeEventListener('pointercancel', cleanupResize);
      window.removeEventListener('blur', cleanupResize);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanupResize);
    window.addEventListener('pointercancel', cleanupResize);
    window.addEventListener('blur', cleanupResize);
  }

  function onResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (sessionListCollapsed) return;
    const SMALL = 10;
    const LARGE = 50;
    let next = sessionListWidth;
    switch (event.key) {
      case 'ArrowLeft':
        next = sessionListWidth - (event.shiftKey ? LARGE : SMALL);
        break;
      case 'ArrowRight':
        next = sessionListWidth + (event.shiftKey ? LARGE : SMALL);
        break;
      case 'Home':
        next = SESSION_LIST_EXPANDED_MIN_WIDTH;
        break;
      case 'End':
        next = SESSION_LIST_EXPANDED_MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    setSessionListWidth(clampSessionListWidth(next));
  }

  function startWorkbarResize(event: PointerEvent<HTMLDivElement>) {
    if (workbarCollapsed) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture can fail if the target is detached mid-drag */
    }
    const startX = event.clientX;
    const start = workbarWidth;
    document.body.classList.add('isResizingWorkbar');
    let cleaned = false;

    function onMove(moveEvent: globalThis.PointerEvent) {
      setWorkbarWidth(clampSessionWorkbarWidth(start + startX - moveEvent.clientX));
    }

    function cleanupResize() {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove('isResizingWorkbar');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanupResize);
      window.removeEventListener('pointercancel', cleanupResize);
      window.removeEventListener('blur', cleanupResize);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanupResize);
    window.addEventListener('pointercancel', cleanupResize);
    window.addEventListener('blur', cleanupResize);
  }

  function onWorkbarResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (workbarCollapsed) return;
    const SMALL = 10;
    const LARGE = 50;
    let next = workbarWidth;
    switch (event.key) {
      case 'ArrowLeft':
        next = workbarWidth + (event.shiftKey ? LARGE : SMALL);
        break;
      case 'ArrowRight':
        next = workbarWidth - (event.shiftKey ? LARGE : SMALL);
        break;
      case 'Home':
        next = SESSION_WORKBAR_MIN_WIDTH;
        break;
      case 'End':
        next = SESSION_WORKBAR_MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    setWorkbarWidth(clampSessionWorkbarWidth(next));
  }

  return {
    startColumnResize,
    onResizeHandleKeyDown,
    startWorkbarResize,
    onWorkbarResizeHandleKeyDown,
  };
}
