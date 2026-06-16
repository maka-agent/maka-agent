/**
 * Shared embedded-browser types crossing the main ↔ preload ↔ renderer
 * boundary (window.maka.browser). The main-process logic that derives these
 * lives in apps/desktop/src/main/browser/logic.ts.
 */

/** Renderer-facing snapshot of one conversation's embedded browser. */
export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  favicon: string | null;
  /** https origin. */
  secure: boolean;
  /** A real page is loaded (not blank / about:) — gates the DOM empty state. */
  hasPage: boolean;
}

/** Where the embedded view sits, in renderer CSS px (1:1 with the window's content DIP). */
export interface BrowserViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
