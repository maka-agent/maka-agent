export function MetricCard(props: { title: string; value: string; detail?: string }) {
  return (
    <div className="settingsMetricCard">
      <small>{props.title}</small>
      <strong>{props.value}</strong>
      {props.detail && <span>{props.detail}</span>}
    </div>
  );
}

// `Segmented` moved to `packages/ui/src/primitives/settings-segmented.tsx`
// as `SettingsSegmented` (Base UI `ToggleGroup`-backed). Imported above
// aliased as `Segmented` so the 3 call sites in this file are
// byte-identical. PR yuejing/settings-segmented-primitive
// (WAWQAQ msg `f1461d30` 用库的应该用库).

/**
 * PR-USE-SHADCN-BASE-UI-BADGE — map the project's status-tone vocabulary
 * (success / warning / destructive / info / neutral) onto the canonical
 * shadcn `PrimitiveBadge` variants. `neutral` falls back to `secondary`
 * which is the closest "muted chip" appearance the Badge primitive ships.
 */
