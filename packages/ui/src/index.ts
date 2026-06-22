export * from './artifact-preview-registry.js';
export * from './assistant-stream.js';
export * from './components.js';
export * from './maka-uri.js';
export * from './materialize.js';
export * from './permission-queue.js';
export * from './redact.js';
export * from './overlay-scroll-area.js';
export * from './smooth-stream.js';
export * from './thinking-stream.js';
export * from './toast.js';
export * from './tool-output-stream.js';
export * from './ui.js';
export * from './utils.js';

// shared primitive UI primitives (copy/own from upstream primitive source). Each file is
// dropped in `./primitives/` with the `cn()` import rewritten to our
// local helper. Net-new components that aren't already covered
// by our shared component-style wrappers in `./ui.js` re-export here so
// consumers can `import { Alert, Empty, Sidebar, ... } from '@maka/ui'`.
export * from './primitives/alert.js';
export * from './primitives/empty.js';
export * from './primitives/spinner.js';
export * from './primitives/kbd.js';
export * from './primitives/menu.js';
export * from './primitives/group.js';
export * from './primitives/frame.js';
export * from './primitives/preview-card.js';
export * from './primitives/input-group.js';
export * from './primitives/pagination.js';
export * from './primitives/sidebar.js';
export * from './primitives/drawer.js';
export * from './primitives/command.js';
export * from './primitives/table.js';
export * from './primitives/toolbar.js';
export {
  Tabs as PrimitiveTabs,
  TabsList as PrimitiveTabsList,
  TabsTrigger as PrimitiveTabsTrigger,
  TabsPanel as PrimitiveTabsPanel,
  TabsContent as PrimitiveTabsContent,
  TabsPrimitive as PrimitiveTabsPrimitive,
} from './primitives/tabs.js';
// PR-USE-SHADCN-BASE-UI-BADGE: the canonical shadcn/base-ui Badge primitive
// (variants: default / destructive / error / info / outline / secondary /
// success / warning). Aliased to PrimitiveBadge so it doesn't collide with
// the legacy `Badge` exported from `ui.tsx`; consumers can pick the version
// they want by import name.
export {
  Badge as PrimitiveBadge,
  badgeVariants as primitiveBadgeVariants,
} from './primitives/badge.js';
export type { BadgeProps as PrimitiveBadgeProps } from './primitives/badge.js';
