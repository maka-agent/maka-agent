"use client";

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { cn } from "../utils.js";
import { bareFieldClasses, inputClasses } from "./input.js";
import type React from "react";

// Base UI NumberField wrappers for the gateway/proxy port inputs that
// hand-converted with Number(event.currentTarget.value). Base UI binds
// value: number | null directly and parses numeric input itself, so the
// call site drops the manual string→number + `|| default` fallback.
//
// NumberFieldInput carries the maka standalone-input look (the same
// inputClasses the native ui.tsx Input used) via the shared `inputClasses`
// export, and the `unstyled` flag gives the bare form for any future
// Field/InputGroup embedding. data-slot follows the style-hook convention
// (item 23).

export function NumberField({
  className,
  ...props
}: NumberFieldPrimitive.Root.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Root
      className={cn("flex min-h-9 w-full", className)}
      data-slot="number-field"
      {...props}
    />
  );
}

export function NumberFieldInput({
  className,
  unstyled = false,
  ...props
}: NumberFieldPrimitive.Input.Props & { unstyled?: boolean }): React.ReactElement {
  return (
    <NumberFieldPrimitive.Input
      className={cn(unstyled ? bareFieldClasses : inputClasses, className)}
      data-slot="number-field-input"
      {...props}
    />
  );
}

export { NumberFieldPrimitive };