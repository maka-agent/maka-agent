import { OverlayScrollArea } from "../overlay-scroll-area.js";
import { cn } from "../utils.js";
import type React from "react";

export function ScrollArea({
  className,
  children,
  scrollFade = false,
  scrollbarGutter = false,
  fill = false,
  clampContentMinWidth = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  scrollFade?: boolean;
  scrollbarGutter?: boolean;
  fill?: boolean;
  clampContentMinWidth?: boolean;
}): React.ReactElement {
  return (
    <OverlayScrollArea
      className={cn("size-full min-h-0", className)}
      viewportClassName={cn(
        "h-full rounded-[inherit] outline-none transition-shadows focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background overscroll-y-contain overscroll-x-contain",
        scrollFade && "maka-overlay-scrollarea-fade [--fade-size:1.5rem]",
        scrollbarGutter && "maka-overlay-scrollarea-gutter",
      )}
      contentClassName={cn(fill && "size-full")}
      contentStyle={clampContentMinWidth ? { minWidth: 0 } : undefined}
      {...props}
    >
      {children}
    </OverlayScrollArea>
  );
}
