export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
export function statusBadgeVariant(tone: StatusTone): 'success' | 'warning' | 'destructive' | 'info' | 'secondary' {
  switch (tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'destructive': return 'destructive';
    case 'info': return 'info';
    case 'neutral': return 'secondary';
  }
}

// `Switch` adapter (15+ settings toggle callsites use `ariaLabel /
// onChange`) was moved to `packages/ui/src/primitives/settings-switch.tsx`
// as `SettingsSwitch`. Imported above as `Switch` so the call sites
// don't need touching. PR yuejing/switch-primitive-and-css-cleanup
// (WAWQAQ msg `f1461d30`).
