/**
 * BrowserPanel (P3) — the renderer half of the embedded browser's right-side
 * panel.
 *
 * The browser itself is a native Electron WebContentsView that floats ABOVE the
 * renderer DOM (not a React child), so this component does not render the page.
 * It draws the chrome (address bar + nav controls) and reserves a strip, then
 * mirrors that strip's on-screen rect to main, which positions the native view
 * to match. When the strip is hidden (a modal is open), the panel unmounts, or
 * no page is loaded yet, it hands main a null rect so the native layer hides and
 * either a centered dialog or the DOM empty state shows through.
 *
 * It mounts only for sessions with a live view (see browser:live), so an
 * ordinary chat reserves no space.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, X } from 'lucide-react';
import type { BrowserState } from '@maka/core';

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  favicon: null,
  secure: false,
  hasPage: false,
};

export function BrowserPanel(props: { sessionId: string; hidden: boolean }) {
  const { sessionId, hidden } = props;
  const stripRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);
  // The address input is editable; it only snaps to the live URL when the user
  // is not mid-edit (tracked by focus) so typing is never clobbered by a
  // did-navigate state push.
  const [address, setAddress] = useState('');
  const editingRef = useRef(false);

  // Subscribe to this session's state pushes + seed the initial state.
  useEffect(() => {
    let alive = true;
    const apply = (next: BrowserState) => {
      if (!alive) return;
      setState(next);
      if (!editingRef.current) setAddress(next.url);
    };
    void window.maka.browser.getState(sessionId).then((s) => apply(s ?? EMPTY_STATE));
    const off = window.maka.browser.onState((payload) => {
      if (payload.sessionId === sessionId) apply(payload.state);
    });
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);

  // Mirror the strip's on-screen rect to main every animation frame while it is
  // showable. Position shifts on window resize and sidebar drags even when the
  // size is unchanged, which a ResizeObserver would miss; a getBoundingClientRect
  // per frame is negligible and the IPC only fires when the rect changes.
  const showView = !hidden && state.hasPage;
  useEffect(() => {
    if (!showView) {
      window.maka.browser.setViewport({ sessionId, rect: null });
      return;
    }
    const el = stripRef.current;
    if (!el) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const r = el.getBoundingClientRect();
      const rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (key !== last) {
        last = key;
        window.maka.browser.setViewport({ sessionId, rect });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.maka.browser.setViewport({ sessionId, rect: null });
    };
  }, [sessionId, showView]);

  const go = useCallback(() => {
    const url = address.trim();
    if (!url) return;
    // Bare hostnames get https://; anything already schemed passes through and
    // main rejects non-web schemes.
    const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    void window.maka.browser.navigate(sessionId, full);
  }, [address, sessionId]);

  return (
    <div className="maka-browser-panel" aria-label="嵌入式浏览器">
      <div className="maka-browser-toolbar">
        <button
          type="button"
          className="maka-browser-navbtn"
          title="后退"
          disabled={!state.canGoBack}
          onClick={() => void window.maka.browser.back(sessionId)}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="maka-browser-navbtn"
          title="前进"
          disabled={!state.canGoForward}
          onClick={() => void window.maka.browser.forward(sessionId)}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="maka-browser-navbtn"
          title={state.loading ? '停止' : '刷新'}
          onClick={() =>
            state.loading ? void window.maka.browser.stop(sessionId) : void window.maka.browser.reload(sessionId)
          }
        >
          {state.loading ? <X size={16} aria-hidden /> : <RotateCw size={16} aria-hidden />}
        </button>
        <input
          className="maka-browser-address"
          type="text"
          spellCheck={false}
          placeholder="输入网址并回车"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={() => {
            editingRef.current = false;
            setAddress(state.url);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
              go();
            }
          }}
        />
        <button
          type="button"
          className="maka-browser-navbtn"
          title="关闭页面"
          onClick={() => void window.maka.browser.close(sessionId)}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="maka-browser-strip" ref={stripRef}>
        {!state.hasPage && (
          <div className="maka-browser-empty">
            <p>嵌入式浏览器</p>
            <p className="maka-browser-empty-hint">输入网址打开页面，或让助手帮你导航并操作。</p>
          </div>
        )}
      </div>
    </div>
  );
}
