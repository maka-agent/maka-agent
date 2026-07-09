# UI Convergence Map (2026-07-09)

Maintainer complaint: shared UI solutions re-implemented per call site. This map inventories
every duplicated recipe family and the extraction sequence. Produced by a read-only audit
agent; token layer (--state-hover-bg/--state-selected-bg, Chip alphas, tabular-nums) is
already contract-governed — the work is moving STRUCTURE onto shared primitives.

## Prioritized extraction sequence

1. **Chip expansion + CSS-label migration** — 7+ hand-rolled tone→alpha tables collapse into
   primitives/chip.tsx. Order: primitive-free CSS labels first (maka-skill-library-status-label,
   maka-plan-run-status, maka-daily-review-archive-status), then settingsAuthActionPill
   (connection.css:160-227), settingsBotStatusPill (bot.css:189-213, add `dot` prop),
   providerCatalogBadge.is-state (models.css:193-198). chip-converge-contract.test.ts already
   pins the target alphas (/12 /14 /18 /15). Badge stays pill-role (badge-converge contract).
2. **Item adoption for list rows** — primitives/item.tsx already encodes 4%/8% fills; add a
   `selected` prop → --state-selected-bg; migrate enabledConnRow, providerCatalogRow,
   maka-skill-library-row, daily-review archive/session rows, settingsOsPermissionRow.
   HIGH contract risk: sidebar-topbar-rail / model-oauth-section / skills.test.ts pins;
   state-token-governance-499 rejects any non-token fill introduced during migration.
3. **PageHeader primitive** — module h2 shells (maka-module-main-header, maka-plan-hero) +
   settings h3 intros (settingsPermissionIntro, settingsHealthIntro, settingsFeatureStatusHero,
   settingsAboutHero). API: title/subtitle/icon/eyebrow/as('h2'|'h3')/actions/meta. Keep class
   hooks for renderer-module-styles + tailwind-compile contracts.
4. **StatTile** — permission.css:547 tile ≈ health.css:118 tile (near-identical); fold
   settings-metric-card.tsx MetricCard + daily-review totals cell. outline|filled emphasis.
   Must bake in tabular-nums (tabular-nums-converge contract).
5. **SectionHeader + ActionRow (+ EmptyState inline variant)** — three section-header dialects
   (maka-skill-section-row / maka-daily-review-section-title with ::before accent bar /
   settingsPermissionSectionHeader); action rows: settingsActionRow already shared, fold
   maka-module-main-actions / maka-plan-top-actions / maka-daily-review-actions.

## Status
- [x] 1 Chip — SHIPPED #681 (5 recipes retired, dot prop added, contract extended)
- [ ] 2 Item rows — started 2026-07-09
- [ ] 3 PageHeader
- [ ] 4 StatTile
- [ ] 5 SectionHeader/ActionRow

(Details per family — implementations with file:line, divergences, risks — are in the audit
agent's report; the essentials are inlined above. Update checkboxes as rounds ship.)
