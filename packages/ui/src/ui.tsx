import React, { forwardRef } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Field as BaseField } from '@base-ui/react/field';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { Check, ChevronDown, X } from './icons.js';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils.js';

export { cn } from './utils.js';

// PR-UIBUTTON-NAV-SIZE-0 (round 12/30): refactored so each
// `size` variant owns its h-* / px-* / text-* utilities.
// Previously these were baked into the base layer, which meant
// callers couldn't introduce a "let className own layout" size
// without `!important`. The `nav` size below adds nothing —
// the consumer's className brings height, padding, font.
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-sm font-medium',
    'transition-[background,border-color,box-shadow,transform,opacity] duration-150 ease-[var(--ease-maka)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:size-[var(--icon-size,1rem)] [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-muted',
        ghost: 'bg-transparent text-foreground hover:bg-muted',
        outline: 'border border-border bg-background text-foreground hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        quiet: 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      },
      size: {
        sm: 'h-8 rounded-sm px-2.5 text-xs',
        md: 'h-9 px-3 text-sm',
        lg: 'h-10 rounded-sm px-4 text-sm',
        icon: 'h-9 w-9 px-0 text-sm',
        'icon-sm': 'h-8 w-8 px-0 text-sm',
        // Bare layout variant. Consumer's className must set
        // height (or min-height), padding, font-size. Used to
        // route raw `<button>` tags whose bespoke CSS encodes
        // tight density that fights the standard size variants
        // (e.g. `.maka-nav-row` is 30px min-height with 3px 6px
        // padding — `h-9 px-3` would inflate it).
        nav: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  },
);

interface ButtonProps
  extends Omit<React.ComponentPropsWithoutRef<typeof BaseButton>, 'className'>,
    VariantProps<typeof buttonVariants> {
  className?: string;
}

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(
  { className, variant, size, ...props },
  ref,
) {
  return (
    <BaseButton
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[var(--radius-pill)] border px-2 py-0.5 text-xs font-medium tabular-nums',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent/10 text-accent',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
        warning: 'border-amber-500/25 bg-amber-500/10 text-amber-800',
        destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
        muted: 'border-border bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

const inputClasses = [
  'flex min-h-9 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm',
  'placeholder:text-muted-foreground/70',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(inputClasses, className)} {...props} />; // a11y-allow: generic wrapper; callers must provide label or aria-label
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(inputClasses, 'min-h-24 resize-y leading-6', className)} {...props} />; // a11y-allow: generic wrapper; callers must provide label or aria-label
});

export const Separator = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSeparator>>(function Separator(
  { className, orientation = 'horizontal', ...props },
  ref,
) {
  return (
    <BaseSeparator
      ref={ref}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
});

export const Checkbox = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseCheckbox.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <BaseCheckbox.Root
      ref={ref}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-input bg-background text-foreground shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'data-[checked]:border-control data-[checked]:bg-control data-[checked]:text-control-foreground',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator className="grid place-items-center">
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
});

export const DialogRoot = BaseDialog.Root;
export const DialogClose = BaseDialog.Close;
const DialogPortal = BaseDialog.Portal;

const DialogBackdrop = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>>(function DialogBackdrop(
  { className, ...props },
  ref,
) {
  return (
    <BaseDialog.Backdrop
      ref={ref}
      // `maka-dialog-backdrop` is a stable, style-free hook so tests and the
      // real-window smoke diagnostic can select the dialog backdrop; Base UI
      // renders only utility classes otherwise, which drift and aren't
      // reliably selectable.
      className={cn('maka-dialog-backdrop fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm', className)}
      {...props}
    />
  );
});

const DialogPopup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseDialog.Popup>>(function DialogPopup(
  { className, children, ...props },
  ref,
) {
  return (
    <BaseDialog.Popup
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid max-h-[85dvh] w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-maka-panel',
        className,
      )}
      {...props}
    >
      {children}
    </BaseDialog.Popup>
  );
});

export const DialogContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPopup> & { showClose?: boolean }
>(function DialogContent({
    className,
    children,
    showClose = true,
    ...props
  },
  ref,
) {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogPopup ref={ref} className={className} {...props}>
        {showClose && (
          <DialogClose
            className={cn(buttonVariants({ variant: 'quiet', size: 'icon-sm' }), 'absolute right-3 top-3')}
            aria-label="关闭"
          >
            <X aria-hidden="true" />
          </DialogClose>
        )}
        {children}
      </DialogPopup>
    </DialogPortal>
  );
});

export const TabsRoot = BaseTabs.Root;
export const TabsList = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseTabs.List>>(function TabsList(
  { className, ...props },
  ref,
) {
  return <BaseTabs.List ref={ref} className={cn('inline-flex items-center rounded-md bg-muted p-1', className)} {...props} />;
});

export const TabsTrigger = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>>(function TabsTrigger(
  { className, ...props },
  ref,
) {
  return (
    <BaseTabs.Tab
      ref={ref}
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
});

export const TabsPanel = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>>(function TabsPanel(
  { className, ...props },
  ref,
) {
  return <BaseTabs.Panel ref={ref} className={cn('focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} {...props} />;
});

export const SelectRoot = BaseSelect.Root;
export const SelectTrigger = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger>>(function SelectTrigger(
  { className, children, ...props },
  ref,
) {
  return (
    <BaseSelect.Trigger
      ref={ref}
      className={cn(buttonVariants({ variant: 'outline' }), 'justify-between', className)}
      {...props}
    >
      {children}
      <BaseSelect.Icon>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
});

export const SelectValue = BaseSelect.Value;
export const SelectPortal = BaseSelect.Portal;
export const SelectPositioner = BaseSelect.Positioner;
export const SelectList = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.List>>(function SelectList(
  { className, ...props },
  ref,
) {
  return <BaseSelect.List ref={ref} className={cn('max-h-[var(--available-height)] overflow-y-auto py-1', className)} {...props} />;
});
export const SelectPopup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Popup>>(function SelectPopup(
  { className, ...props },
  ref,
) {
  // The Settings modal uses `--z-modal` (200) — the previous bare
  // popup layer (Tailwind utility worth 50) was below it, so any
  // `<SettingsSelect>` opened inside a modal (e.g. Daily Review
  // → 分析模型) rendered its popup beneath the modal content and
  // read as "can't select". Pin the popup to `--z-overlay` (300)
  // so it always floats above the modal it was triggered from
  // (WAWQAQ msg `d3ea9a33` 2026-06-26).
  return <BaseSelect.Popup ref={ref} className={cn('z-[var(--z-overlay)] min-w-40 rounded-md bg-popover p-1 text-popover-foreground shadow-maka-panel', className)} {...props} />;
});
export const SelectGroup = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Group>>(function SelectGroup(
  { className, ...props },
  ref,
) {
  return <BaseSelect.Group ref={ref} className={cn('py-1', className)} {...props} />;
});
export const SelectGroupLabel = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.GroupLabel>>(function SelectGroupLabel(
  { className, ...props },
  ref,
) {
  return <BaseSelect.GroupLabel ref={ref} className={cn('px-2 py-1 text-xs font-medium text-muted-foreground', className)} {...props} />;
});
export const SelectSeparator = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Separator>>(function SelectSeparator(
  { className, ...props },
  ref,
) {
  return <BaseSelect.Separator ref={ref} className={cn('my-1 h-px bg-border', className)} {...props} />;
});

export const SelectItem = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Item>>(function SelectItem(
  { className, children, ...props },
  ref,
) {
  return (
    <BaseSelect.Item
      ref={ref}
      className={cn('grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[selected]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)}
      {...props}
    >
      <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
        <BaseSelect.ItemIndicator>
          <Check size={13} strokeWidth={2} aria-hidden="true" />
        </BaseSelect.ItemIndicator>
      </span>
      <span className="min-w-0">
        <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
      </span>
    </BaseSelect.Item>
  );
});

// =============================================================
// Field + Form
// Base UI's Field handles label / control / description / error
// association automatically via aria-describedby and aria-invalid.
// =============================================================

export const FieldRoot = BaseField.Root;
export const FieldDescription = forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<typeof BaseField.Description>>(function FieldDescription(
  { className, ...props },
  ref,
) {
  return <BaseField.Description ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />;
});
export const Label = forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<typeof BaseField.Label>>(function Label(
  { className, ...props },
  ref,
) {
  return <BaseField.Label ref={ref} className={cn('text-sm font-medium text-foreground', className)} {...props} />;
});

// =============================================================
// Switch
// =============================================================

export const Switch = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseSwitch.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <BaseSwitch.Root
      ref={ref}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input bg-muted shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'data-[checked]:bg-control data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-background shadow transition-transform data-[checked]:translate-x-[1.125rem]" />
    </BaseSwitch.Root>
  );
});

// =============================================================
// Toggle + ToggleGroup
// =============================================================

export const Toggle = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseToggle>
>(function Toggle({ className, ...props }, ref) {
  return (
    <BaseToggle
      ref={ref}
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-sm bg-transparent px-2.5 text-sm font-medium text-foreground transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'data-[pressed]:bg-muted data-[pressed]:text-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

export const ToggleGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseToggleGroup>
>(function ToggleGroup({ className, ...props }, ref) {
  return (
    <BaseToggleGroup
      ref={ref}
      className={cn('inline-flex items-center gap-1 rounded-md bg-muted p-1', className)}
      {...props}
    />
  );
});

// =============================================================
// RadioGroup + Radio
// =============================================================

export const RadioGroup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseRadioGroup>
>(function RadioGroup({ className, ...props }, ref) {
  return <BaseRadioGroup ref={ref} className={cn('grid gap-2', className)} {...props} />;
});

export const Radio = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseRadio.Root>
>(function Radio({ className, ...props }, ref) {
  return (
    <BaseRadio.Root
      ref={ref}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-input bg-background shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'data-[checked]:border-control data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <BaseRadio.Indicator className="grid place-items-center">
        <span className="block h-2 w-2 rounded-full bg-control" />
      </BaseRadio.Indicator>
    </BaseRadio.Root>
  );
});

// =============================================================
// Progress
// =============================================================

export const Progress = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseProgress.Root>
>(function Progress({ className, ...props }, ref) {
  return (
    <BaseProgress.Root
      ref={ref}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <BaseProgress.Track className="absolute inset-0 overflow-hidden">
        <BaseProgress.Indicator className="block h-full origin-left bg-control transition-transform" />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
});

// Toast — left to the existing `packages/ui/src/toast.tsx` for now.
// That module already wraps Base UI Toast with the project's
// `useToast()` / `toast.confirm()` API. Rewriting it to expose the
// raw Base UI primitives here would compete with the existing
// caller surface; the modernization is tracked separately.
