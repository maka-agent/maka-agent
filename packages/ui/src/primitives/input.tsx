"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "../utils.js";
import type * as React from "react";

// #520 item 22: the canonical Input. Retires the native ui.tsx Input onto Base
// UI's Input primitive, porting maka's inputClasses styling as the default
// chrome so the 44 usages across 9 files keep their look. Stays a single
// <input> (no span wrapper) so caller CSS targeting `> input` /
// `input:focus-visible` still matches; the unstyled flag gives the bare form
// for Field/InputGroup embedding.
export const inputClasses = [
  'flex min-h-9 w-full rounded-sm border border-input bg-[oklch(from_var(--foreground)_l_c_h_/_0.02)] px-3 py-2 text-sm text-foreground shadow-sm',
  'placeholder:text-foreground-secondary/70',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export const bareFieldClasses = [
  'appearance-none rounded-none border-0 bg-transparent p-0 text-inherit shadow-none outline-none [font:inherit]',
  'focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ');

export type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, 'size'> & {
  unstyled?: boolean;
};

export function Input({
  className,
  unstyled = false,
  ...props
}: InputProps): React.ReactElement {
  return (
    <InputPrimitive
      className={cn(
        unstyled ? bareFieldClasses : inputClasses,
        // type="search": hide the native WebKit cancel/decoration/results
        // widgets so the app's own clear button (SearchModal, memory filter,
        // model search) is the single clear affordance. Main's primitives/input
        // always applied this; port it so the unified Input keeps the contract.
        props.type === 'search' &&
          '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none',
        className,
      )}
      data-slot="input"
      {...props}
      data-maka-field-chrome={unstyled ? 'none' : undefined}
    />
  );
}