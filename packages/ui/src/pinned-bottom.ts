export interface PinnedBottomViewport {
  scrollTop: number;
  readonly scrollHeight: number;
}

export interface PinnedBottomObserver {
  observe(element: Element, options?: MutationObserverInit): void;
  disconnect(): void;
}

export type PinnedBottomObserverFactory = (callback: () => void) => PinnedBottomObserver;

/**
 * Follows the scroll content's actual commit clock. Streaming text is revealed
 * by requestAnimationFrame after raw deltas arrive, while OverlayScrollbars
 * keeps the outer content box viewport-sized; observing raw state or that fixed
 * box cannot keep a pinned viewport aligned with each visible growth step.
 */
export function createPinnedBottomFollower(options: {
  viewport: PinnedBottomViewport;
  content: Element;
  isPinned: () => boolean;
  createObserver?: PinnedBottomObserverFactory;
}): () => void {
  const follow = (): void => {
    if (options.isPinned()) options.viewport.scrollTop = options.viewport.scrollHeight;
  };
  const createObserver = options.createObserver
    ?? (typeof MutationObserver === 'function'
      ? (callback: () => void) => new MutationObserver(callback)
      : undefined);
  if (!createObserver) return () => {};
  const observer = createObserver(follow);
  observer.observe(options.content, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
