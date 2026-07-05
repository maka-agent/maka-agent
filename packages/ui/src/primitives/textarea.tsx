"use client";

import { cn } from "../utils.js";
import { bareFieldClasses, inputClasses } from "./input.js";
import type * as React from "react";

// #520 item 22: canonical Textarea, parallel to primitives/input. Retires the
// native ui.tsx Textarea. Stays a single <textarea> (no span wrapper, no Base
// UI Field.Control) so caller CSS targeting `> textarea` / `textarea:focus-
// visible` still matches. Base UI ships no Textarea component, so this is a
// native textarea with maka's inputClasses chrome (plus textarea sizing).
export type TextareaProps = React.ComponentPropsWithRef<"textarea"> & {
  unstyled?: boolean;
};

export function Textarea({
  className,
  unstyled = false,
  ref,
  ...props
}: TextareaProps): React.ReactElement {
  return (
    <textarea
      ref={ref}
      className={cn(unstyled ? bareFieldClasses : [inputClasses, 'min-h-24 resize-y leading-6'], className)}
      data-slot="textarea"
      {...props}
      data-maka-field-chrome={unstyled ? 'none' : undefined}
    />
  );
}