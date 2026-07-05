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
import { ChevronLeft, ChevronRight, Globe, RotateCw, X } from '@maka/ui/icons';
import { normalizeBrowserAddressInput, type BrowserState } from '@maka/core';
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
} from '@maka/ui';

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

function browserAddressFailureCopy(reason: 'unsupported_scheme' | 'invalid_url'): string {
  switch (reason) {
    case 'unsupported_scheme':
      return '嵌入式浏览器只支持打开 HTTP/HTTPS 网页地址。';
    case 'invalid_url':
      return '这个地址无法识别，请检查网址后重试。';
  }
}

export function BrowserPanel(props: { sessionId: string; hidden: boolean }) {
  const { sessionId, hidden } = props;
  const toast = useToast();
  const stripRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);
  // The address input is editable; it only snaps to the live URL when the user
  // is not mid-edit (tracked by focus) so typing is never clobbered by a
  // did-navigate state push.
  const [address, setAddress] = useState('');
  const editingRef = useRef(false);
  const browserPanelMountedRef = useRef(false);
  const browserPanelSessionIdRef = useRef(sessionId);

  browserPanelSessionIdRef.current = sessionId;

  useEffect(() => {
    browserPanelMountedRef.current = true;
    return () => {
      browserPanelMountedRef.current = false;
    };
  }, []);

  const isBrowserPanelSessionCurrent = useCallback((ownerSessionId: string): boolean => {
    return browserPanelMountedRef.current && browserPanelSessionIdRef.current === ownerSessionId;
  }, []);

  // Subscribe to this session's state pushes + seed the initial state.
  useEffect(() => {
    let alive = true;
    editingRef.current = false;
    setState(EMPTY_STATE);
    setAddress('');
    const apply = (next: BrowserState) => {
      if (!alive) return;
      setState(next);
      if (!editingRef.current) setAddress(next.url);
    };
    void window.maka.browser
      .getState(sessionId)
      .then((s) => apply(s ?? EMPTY_STATE))
      .catch(() => apply(EMPTY_STATE));
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
    const result = normalizeBrowserAddressInput(address);
    if (!result.ok) {
      if (result.reason !== 'empty') {
        toast.error('无法打开地址', browserAddressFailureCopy(result.reason));
      }
      return;
    }
    const ownerSessionId = sessionId;
    void window.maka.browser.navigate(ownerSessionId, result.url).catch(() => {
      if (isBrowserPanelSessionCurrent(ownerSessionId)) {
        toast.error('浏览器导航失败', '页面暂时无法打开，请稍后重试。');
      }
    });
  }, [address, isBrowserPanelSessionCurrent, sessionId, toast]);

  return (
    <div className="maka-browser-panel" aria-label="嵌入式浏览器">
      <div className="maka-browser-toolbar">
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-browser-navbtn"
            aria-label="浏览器后退"
            disabled={!state.canGoBack}
            onClick={() => void window.maka.browser.back(sessionId)}
          >
            <ChevronLeft size={16} aria-hidden />
          </TooltipTrigger>
          <TooltipContent>后退</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-browser-navbtn"
            aria-label="浏览器前进"
            disabled={!state.canGoForward}
            onClick={() => void window.maka.browser.forward(sessionId)}
          >
            <ChevronRight size={16} aria-hidden />
          </TooltipTrigger>
          <TooltipContent>前进</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-browser-navbtn"
            aria-label={state.loading ? '停止加载页面' : '刷新页面'}
            disabled={!state.hasPage && !state.loading}
            onClick={() =>
              state.loading ? void window.maka.browser.stop(sessionId) : void window.maka.browser.reload(sessionId)
            }
          >
            {state.loading ? <X size={16} aria-hidden /> : <RotateCw size={16} aria-hidden />}
          </TooltipTrigger>
          <TooltipContent>{state.loading ? '停止' : '刷新'}</TooltipContent>
        </Tooltip>
        <Input
          className="maka-browser-address"
          type="text"
          spellCheck={false}
          aria-label="浏览器地址"
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
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-browser-navbtn"
            aria-label="关闭浏览器页面"
            onClick={() => void window.maka.browser.close(sessionId)}
          >
            <X size={16} aria-hidden />
          </TooltipTrigger>
          <TooltipContent>关闭页面</TooltipContent>
        </Tooltip>
      </div>
      <div className="maka-browser-strip" ref={stripRef}>
        {!state.hasPage && (
          <Empty className="maka-browser-empty absolute inset-0 py-10 md:py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Globe aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>嵌入式浏览器</EmptyTitle>
              <EmptyDescription className="maka-browser-empty-hint">
                输入网址打开页面，或让助手帮你导航并操作。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
