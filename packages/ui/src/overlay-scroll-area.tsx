import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { OverlayScrollbars, type OverlayScrollbars as OverlayScrollbarsInstance, type PartialOptions } from 'overlayscrollbars';
import { cn } from './utils.js';

export interface OverlayScrollAreaProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  children: React.ReactNode;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  viewportClassName?: string;
  options?: PartialOptions;
}

const DEFAULT_OVERLAY_SCROLL_OPTIONS: PartialOptions = {
  scrollbars: {
    theme: 'os-theme-maka',
    autoHide: 'move',
    autoHideDelay: 450,
    clickScroll: true,
  },
  overflow: {
    x: 'hidden',
    y: 'scroll',
  },
};

function mergeOverlayScrollOptions(options?: PartialOptions): PartialOptions {
  return {
    ...DEFAULT_OVERLAY_SCROLL_OPTIONS,
    ...options,
    overflow: {
      ...DEFAULT_OVERLAY_SCROLL_OPTIONS.overflow,
      ...options?.overflow,
    },
    scrollbars: {
      ...DEFAULT_OVERLAY_SCROLL_OPTIONS.scrollbars,
      ...options?.scrollbars,
    },
  };
}

export const OverlayScrollArea = forwardRef<HTMLDivElement, OverlayScrollAreaProps>(
  function OverlayScrollArea(
    { children, className, contentClassName, contentStyle, options, viewportClassName, ...viewportProps },
    forwardedRef,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const instanceRef = useRef<OverlayScrollbarsInstance | null>(null);
    const overlayOptions = useMemo(() => mergeOverlayScrollOptions(options), [options]);

    useImperativeHandle(forwardedRef, () => viewportRef.current as HTMLDivElement, []);

    useEffect(() => {
      const host = hostRef.current;
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!host || !viewport || !content) return undefined;

      const instance = OverlayScrollbars(
        {
          target: host,
          elements: {
            viewport,
            content,
          },
        },
        overlayOptions,
      );
      instanceRef.current = instance;
      return () => {
        instance.destroy();
        instanceRef.current = null;
      };
    }, []);

    useEffect(() => {
      instanceRef.current?.options(overlayOptions, true);
    }, [overlayOptions]);

    return (
      <div
        ref={hostRef}
        className={cn('maka-overlay-scrollarea', className)}
        data-overlayscrollbars="host"
        data-overlayscrollbars-initialize=""
      >
        <div
          ref={viewportRef}
          className={cn('maka-overlay-scrollarea-viewport', viewportClassName)}
          data-overlayscrollbars-viewport=""
          data-overlayscrollbars-initialize=""
          {...viewportProps}
        >
          <div
            ref={contentRef}
            className={cn('maka-overlay-scrollarea-content', contentClassName)}
            data-overlayscrollbars-content=""
            style={contentStyle}
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);
