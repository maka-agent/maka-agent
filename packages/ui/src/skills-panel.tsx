import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import {
  Blocks,
  Download,
  FileEdit,
  Loader2,
  Search,
} from './icons.js';
import type { CapabilityAuditReport } from '@maka/core';
import { deriveCapabilityAuditReport } from '@maka/core';
import {
  Button as UiButton,
  DialogContent,
  DialogRoot,
  Switch,
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsPanel,
} from './ui.js';
import { Chip, type ChipProps } from './primitives/chip.js';
import { DialogHeader } from './primitives/dialog-header.js';
import { PageHeader } from './primitives/page-header.js';
import { Input } from './primitives/input.js';
import { EmptyState } from './empty-state.js';
import { SectionHeader } from './primitives/section-header.js';
import { CapabilityAuditStrip } from './capability-audit-strip.js';
import type { BundledSkillCatalogEntry, SkillEntry } from './module-panel-types.js';
import { getSkillsCopy, type SkillsCopy } from './skills-copy.js';
import { useUiLocale } from './locale-context.js';

type SkillStatusFilter = 'all' | 'usable' | 'attention' | 'unavailable';

function SkillLibraryPanel(props: {
  skills?: SkillEntry[];
  skillHostBasis?: 'session' | 'desktop_default';
  onRefreshSkills?(): void | Promise<void>;
  onOpenSkill?(entryKey: string, repairTarget: SkillEntry['repairTarget']): void | Promise<void>;
  actionBusy?: boolean;
  refreshPending?: boolean;
  openingSkillId?: string | null;
  searchQuery?: string;
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  onActivateBundledSkill?(id: string): boolean | Promise<boolean>;
  onSetSkillEnabled?(entryKey: string, enabled: boolean): boolean | Promise<boolean>;
  activatingBundledId?: string | null;
  togglingSkillEntryKey?: string | null;
}) {
  const copy = getSkillsCopy(useUiLocale());
  const skillCount = props.skills?.length ?? 0;
  const [activeSkillTab, setActiveSkillTab] = useState<'builtin' | 'installed'>(() => {
    const visualView = typeof document === 'undefined' ? undefined : document.documentElement.dataset.makaExtensionView;
    if (visualView === 'skills_available' || visualView === 'skills_activation_confirm') return 'builtin';
    if (visualView === 'skills_diagnostics' || visualView === 'skills_toggle') return 'installed';
    const skills = props.skills ?? [];
    // Land on 已发现 when the current session has scanned Skill entries;
    // otherwise open on 内置, the always-populated shipped catalog.
    if (skills.length > 0) return 'installed';
    return 'builtin';
  });
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>('all');
  const [reviewTemplateId, setReviewTemplateId] = useState<string | null>(null);
  const [confirmTemplateId, setConfirmTemplateId] = useState<string | null>(null);
  const [detailEntryKey, setDetailEntryKey] = useState<string | null>(null);
  const normalizedSkillQuery = props.searchQuery?.trim().toLowerCase() ?? '';
  const filteredSkills = (props.skills ?? []).filter((skill) => {
    const queryMatches = !normalizedSkillQuery
      || `${skill.id} ${skill.name} ${skill.description ?? ''} ${skill.displayPath}`.toLowerCase().includes(normalizedSkillQuery);
    return queryMatches && matchesSkillStatusFilter(skill, statusFilter);
  });
  // 可启用 = shipped templates that only join the runtime after the user
  // explicitly creates a Maka-workspace copy. 已发现 = the read-only runtime
  // inspection across project, Maka-workspace, and user sources.
  const bundledCatalog = (props.bundledSkillCatalog ?? []).filter(
    (entry) => entry.activationState === 'available',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.documentElement.dataset.makaExtensionView !== 'skills_activation_confirm') return;
    const first = bundledCatalog[0];
    if (first) setConfirmTemplateId(first.id);
  }, [bundledCatalog[0]?.id]);
  const reviewTemplate = bundledCatalog.find((entry) => entry.id === reviewTemplateId);
  const confirmTemplate = bundledCatalog.find((entry) => entry.id === confirmTemplateId);
  const detailSkill = (props.skills ?? []).find((entry) => entry.entryKey === detailEntryKey);
  const bundledCatalogFiltered = bundledCatalog.filter((entry) => {
    if (!normalizedSkillQuery) return true;
    return `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(normalizedSkillQuery);
  });
  const installedSkills = filteredSkills;
  const projectSkills = installedSkills.filter((skill) => skill.discoveryOrigin === 'project_maka' || skill.discoveryOrigin === 'project_agents');
  const workspaceSkills = installedSkills.filter((skill) => skill.discoveryOrigin === 'workspace');
  const userSkills = installedSkills.filter((skill) => skill.discoveryOrigin === 'user_maka' || skill.discoveryOrigin === 'user_agents');
  // Collision-only slug reveal: the slug normally lives in the row tooltip,
  // but when two visible skills share a display name (e.g. repeated starter
  // templates from old builds) the rows become indistinguishable — surface
  // the slug inline exactly for those rows.
  const skillNameCounts = new Map<string, number>();
  for (const skill of filteredSkills) {
    skillNameCounts.set(skill.name, (skillNameCounts.get(skill.name) ?? 0) + 1);
  }
  const skillListEmptyTitle = normalizedSkillQuery ? copy.installed.emptySearchTitle : copy.installed.emptyTitle;
  const skillListEmptyBody: ReactNode = normalizedSkillQuery ? copy.installed.emptySearchBody : (
    <>
      {copy.installed.emptyBodyBeforeCode} <code className="maka-empty-state-code">SKILL.md</code>{' '}
      {copy.installed.emptyBodyAfterCode}
    </>
  );

  const tabs = (
    <div className="maka-skill-tabs-bar">
      <TabsList variant="underline" className="maka-skill-tabs" aria-label={copy.tabs.ariaLabel}>
        {([
          ['builtin', copy.tabs.builtin, bundledCatalog.length],
          ['installed', copy.tabs.installed, installedSkills.length],
        ] as const).map(([tab, label, count]) => (
          <TabsTrigger
            key={tab}
            className="maka-skill-tab"
            value={tab}
          >
            {label}
            <span>{count}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );

  const builtinCatalog = (
    <section className="maka-skill-catalog" aria-label={copy.builtin.ariaLabel}>
      <SectionHeader
        className="maka-skill-section-row"
        title={<span className="maka-skill-section-label">{copy.builtin.title}</span>}
      />
      <p className="maka-skill-catalog-scope">{copy.activation.scopeHelp}</p>
      {bundledCatalog.length === 0 ? (
        <EmptyState
          Icon={Blocks}
          title={copy.builtin.emptyTitle}
          body={copy.builtin.emptyBody}
          extraClassName="maka-skill-installed-empty"
        />
      ) : bundledCatalogFiltered.length === 0 ? (
        <EmptyState
          Icon={Search}
          title={copy.builtin.noMatchTitle}
          body={copy.builtin.noMatchBody}
          extraClassName="maka-skill-installed-empty"
        />
      ) : (
        <div className="maka-skill-catalog-grid">
          {bundledCatalogFiltered.map((entry) => {
            const activating = props.activatingBundledId === entry.id;
            const description = entry.description || copy.builtin.fallback;
            return (
              <article key={entry.id} className="maka-skill-catalog-card">
                <div className="maka-skill-catalog-card-head">
                  <span className="maka-skill-catalog-icon" aria-hidden="true">
                    <Blocks size={18} />
                  </span>
                  <div className="maka-skill-catalog-card-title">
                    <h3>{entry.name}</h3>
                    <small>{entry.id}</small>
                  </div>
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setReviewTemplateId(entry.id)}
                    disabled={props.actionBusy}
                    aria-label={copy.activation.action(entry.name)}
                    title={copy.activation.action(entry.name)}
                  >
                    {activating ? <Loader2 size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
                    {copy.activation.details}
                  </UiButton>
                </div>
                <p>{description}</p>
                <div className="maka-skill-catalog-card-foot">
                  <Chip size="sm" variant="neutral" className="maka-skill-catalog-category">{copy.categories[entry.category]}</Chip>
                  <div className="maka-skill-catalog-card-actions">
                    <UiButton
                      type="button"
                      size="sm"
                      onClick={() => setConfirmTemplateId(entry.id)}
                      disabled={props.actionBusy || !props.onActivateBundledSkill}
                      aria-label={`${copy.activation.enable}: ${entry.name}`}
                    >
                      <Download size={16} aria-hidden="true" />
                      {copy.activation.enable}
                    </UiButton>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const skillList = (list: SkillEntry[], emptyTitle: string, emptyBody: ReactNode, label: string) => (
    <section className="maka-skill-installed" aria-label={label}>
      {list.length === 0 ? (
        <EmptyState
          Icon={Blocks}
          title={emptyTitle}
          body={emptyBody}
          cta={props.onRefreshSkills ? {
            label: props.refreshPending ? copy.installed.refreshPending : copy.installed.refresh,
            onClick: props.onRefreshSkills,
            disabled: props.actionBusy,
          } : undefined}
          extraClassName="maka-skill-installed-empty"
        />
      ) : (
        <>
          <SectionHeader
            className="maka-skill-section-row"
            title={<span className="maka-skill-section-label">{label}</span>}
            count={copy.installed.count(list.length)}
          />
          <ul className="maka-skill-library-list" aria-label={copy.installed.listAriaLabel}>
            {list.map((skill) => {
              const tools = skill.declaredTools ?? [];
              const toolsLabel = tools.length > 0 ? tools.join(', ') : '';
              const description = formatSkillLibraryDescription(skill, copy);
              const statusLabel = formatSkillStatusLabel(skill, copy);
              const runtimeLabel = formatSkillRuntimeLabel(skill, copy);
              const lifecycleReason = formatSkillLifecycleReason(skill, copy);
              const opening = props.openingSkillId === skill.entryKey;
              const toggling = props.togglingSkillEntryKey === skill.entryKey;
              const needsRepair = skill.operationalStatus === 'invalid' || skill.operationalStatus === 'state_error';
              const hoverText = tools.length > 0
                ? copy.row.hoverWithTools(skill.id, runtimeLabel, statusLabel, toolsLabel)
                : copy.row.hover(skill.id, runtimeLabel, statusLabel);
              return (
                <li key={skill.entryKey} className="maka-skill-library-item" data-runtime-status={skill.operationalStatus}>
                  <div
                    className="maka-skill-library-row"
                    title={hoverText}
                  >
                    <span className="maka-skill-library-status" aria-hidden="true">
                      <Blocks size={16} />
                    </span>
                    <span className="maka-skill-library-copy">
                      <span className="maka-skill-library-name">
                        {skill.name}
                        {(skillNameCounts.get(skill.name) ?? 0) > 1 && (
                          <span className="maka-skill-library-slug">{skill.id}</span>
                        )}
                      </span>
                      {description && (
                        <span className="maka-skill-library-description">{description}</span>
                      )}
                      <span className="maka-skill-library-path">{skill.displayPath}</span>
                      {lifecycleReason && (
                        <span className="maka-skill-library-lifecycle-reason">{lifecycleReason}</span>
                      )}
                    </span>
                    <span className="maka-skill-library-meta">
                      {/* The slug lives in the row's title tooltip
                          (技能：${skill.id}) — the reference row
                          shows only name + description. The status chips below
                          stay (exception-only tone). */}
                      {/* Detail round 6, exception-only: the adjacent Switch
                          already says enabled/disabled — the visible chip only
                          appears for states the switch can't express
                          (state_error). 已启用/已停用 stay in the hover text. */}
                      {skill.operationalStatus !== 'eligible' && (
                        <Chip size="sm" variant={skillOperationalChipTone(skill)} className="maka-skill-library-runtime-label" data-status={skill.operationalStatus}>{runtimeLabel}</Chip>
                      )}
                      <Chip size="sm" variant="neutral" className="maka-skill-library-origin-label">{copy.status.origin[skill.discoveryOrigin]}</Chip>
                      {shouldShowSkillGovernanceChip(skill) && (
                        <Chip size="sm" variant={skillStatusChipTone(skill)} className="maka-skill-library-status-label" data-status={skill.managedUpdateStatus ?? skill.validationStatus ?? skill.sourceType ?? 'workspace'}>{statusLabel}</Chip>
                      )}
                      {opening && <span>{copy.row.opening}</span>}
                      {skill.canToggle && (
                        <Switch
                          checked={skill.operationalStatus !== 'disabled'}
                          disabled={props.actionBusy || !props.onSetSkillEnabled}
                          aria-label={skill.operationalStatus === 'disabled'
                            ? copy.row.enableAriaLabel(skill.name)
                            : copy.row.disableAriaLabel(skill.name)}
                          title={skill.operationalStatus === 'disabled'
                            ? copy.row.enableGlobalTitle
                            : copy.row.disableGlobalTitle}
                          onCheckedChange={(checked) => {
                            void props.onSetSkillEnabled?.(skill.entryKey, checked);
                          }}
                        />
                      )}
                      {toggling && <span>{copy.row.toggling}</span>}
                    </span>
                  </div>
                  <UiButton
                    type="button"
                    variant="quiet"
                    size="sm"
                    onClick={() => setDetailEntryKey(skill.entryKey)}
                    disabled={props.actionBusy}
                    aria-label={`${copy.details.action}: ${skill.name}`}
                  >
                    {copy.details.action}
                  </UiButton>
                  <UiButton
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    className="maka-skill-library-open-button"
                    onClick={() => props.onOpenSkill?.(skill.entryKey, skill.repairTarget)}
                    disabled={props.actionBusy || !props.onOpenSkill || !skill.canOpen}
                    aria-label={needsRepair ? copy.row.openRepairAriaLabel(skill.name) : copy.row.openAriaLabel(skill.name)}
                    title={needsRepair ? copy.row.openRepairTitle : copy.row.openTitle}
                  >
                    {opening ? <Loader2 size={15} aria-hidden="true" /> : <FileEdit size={15} aria-hidden="true" />}
                  </UiButton>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );

  return (
    <div className="maka-skill-library" aria-busy={props.actionBusy ? 'true' : undefined}>
      <TabsRoot value={activeSkillTab} onValueChange={(v) => setActiveSkillTab(v as 'builtin' | 'installed')}>
        {tabs}
        <TabsPanel value="builtin">{builtinCatalog}</TabsPanel>
        <TabsPanel value="installed">
          <p className="maka-skill-global-scope">{copy.installed.globalScope}</p>
          <div className="maka-skill-status-filters" role="group" aria-label={copy.installed.filters.ariaLabel}>
            {([
              ['all', copy.installed.filters.all],
              ['usable', copy.installed.filters.usable],
              ['attention', copy.installed.filters.attention],
              ['unavailable', copy.installed.filters.unavailable],
            ] as const).map(([value, label]) => (
              <UiButton
                key={value}
                type="button"
                size="sm"
                variant={statusFilter === value ? 'secondary' : 'quiet'}
                aria-pressed={statusFilter === value}
                onClick={() => setStatusFilter(value)}
              >
                {label}
                <span>{countSkillsForFilter(props.skills ?? [], value)}</span>
              </UiButton>
            ))}
          </div>
          <p className="maka-skill-status-filter-help">{copy.installed.filterHelp}</p>
          {props.skillHostBasis && installedSkills.length > 0 && (
            <p className="maka-skill-compatibility-basis">
              {copy.installed.compatibilityBasis[props.skillHostBasis]}
            </p>
          )}
          {installedSkills.length === 0
            ? skillList(installedSkills, skillListEmptyTitle, skillListEmptyBody, copy.installed.sectionLabel)
            : (
              <>
                {projectSkills.length > 0 && skillList(projectSkills, skillListEmptyTitle, skillListEmptyBody, copy.installed.projectSection)}
                {workspaceSkills.length > 0 && skillList(workspaceSkills, skillListEmptyTitle, skillListEmptyBody, copy.installed.workspaceSection)}
                {userSkills.length > 0 && skillList(userSkills, skillListEmptyTitle, skillListEmptyBody, copy.installed.userSection)}
              </>
            )}
        </TabsPanel>
      </TabsRoot>
      {props.skills && props.skills.length > 0 ? (
        <span className="maka-skill-tool-summary-hidden" aria-hidden="true">
          {copy.installed.summary(skillCount, new Set((props.skills ?? []).flatMap((skill) => skill.declaredTools ?? [])).size)}
        </span>
      ) : null}
      <DialogRoot
        open={reviewTemplate != null}
        onOpenChange={(open) => {
          if (!open && props.activatingBundledId == null) setReviewTemplateId(null);
        }}
      >
        {reviewTemplate && (
          <DialogContent
            className="maka-modal maka-skill-dialog"
            aria-labelledby="maka-skill-template-review-title"
            showClose={false}
          >
            <DialogHeader
              icon={<Blocks aria-hidden="true" />}
              title={copy.activation.details}
              subtitle={`${reviewTemplate.name} · ${reviewTemplate.id}`}
              titleId="maka-skill-template-review-title"
              closeLabel={copy.activation.close}
              onClose={() => setReviewTemplateId(null)}
            />
            <div className="maka-skill-dialog-body">
              <p>{reviewTemplate.description || copy.builtin.fallback}</p>
              <SkillDetailField label={copy.activation.target} value={reviewTemplate.targetPath} mono />
              <SkillDetailField label={copy.activation.requestedTools} value={formatStringList(reviewTemplate.declaredTools, copy.activation.none)} />
              <SkillDetailField label={copy.activation.requiredTools} value={formatStringList(reviewTemplate.requiredTools, copy.activation.none)} />
              <SkillDetailField label={copy.activation.requiredCapabilities} value={formatStringList(reviewTemplate.requiredCapabilities, copy.activation.none)} />
              <p className="maka-skill-dialog-notice">{copy.activation.scopeHelp}</p>
              <p className="maka-skill-dialog-notice">{copy.activation.permissionNotice}</p>
            </div>
            <div className="maka-skill-dialog-actions">
              <UiButton type="button" variant="secondary" onClick={() => setReviewTemplateId(null)} disabled={props.activatingBundledId != null}>
                {copy.activation.close}
              </UiButton>
              <UiButton
                type="button"
                onClick={() => {
                  setReviewTemplateId(null);
                  setConfirmTemplateId(reviewTemplate.id);
                }}
                disabled={props.actionBusy || !props.onActivateBundledSkill}
              >
                <Download size={16} aria-hidden="true" />
                {copy.activation.enable}
              </UiButton>
            </div>
          </DialogContent>
        )}
      </DialogRoot>
      <DialogRoot
        open={confirmTemplate != null}
        onOpenChange={(open) => {
          if (!open && props.activatingBundledId == null) setConfirmTemplateId(null);
        }}
      >
        {confirmTemplate && (
          <DialogContent
            className="maka-modal maka-skill-dialog"
            aria-labelledby="maka-skill-template-confirm-title"
            showClose={false}
          >
            <DialogHeader
              icon={<Download aria-hidden="true" />}
              title={copy.activation.confirmTitle}
              subtitle={`${confirmTemplate.name} · ${confirmTemplate.id}`}
              titleId="maka-skill-template-confirm-title"
              closeLabel={copy.activation.cancel}
              onClose={() => setConfirmTemplateId(null)}
            />
            <div className="maka-skill-dialog-body">
              <p>{copy.activation.confirmDescription}</p>
              <SkillDetailField label={copy.activation.target} value={confirmTemplate.targetPath} mono />
              <p className="maka-skill-dialog-notice">{copy.activation.scopeHelp}</p>
              <p className="maka-skill-dialog-notice">{copy.activation.permissionNotice}</p>
              <p className="maka-skill-dialog-notice">{copy.activation.noOverwriteNotice}</p>
            </div>
            <div className="maka-skill-dialog-actions">
              <UiButton
                type="button"
                variant="secondary"
                onClick={() => setConfirmTemplateId(null)}
                disabled={props.activatingBundledId != null}
              >
                {copy.activation.cancel}
              </UiButton>
              <UiButton
                type="button"
                onClick={() => {
                  void Promise.resolve(props.onActivateBundledSkill?.(confirmTemplate.id)).then((activated) => {
                    if (activated) setConfirmTemplateId(null);
                  });
                }}
                disabled={props.actionBusy || !props.onActivateBundledSkill}
              >
                {props.activatingBundledId === confirmTemplate.id
                  ? <Loader2 size={16} aria-hidden="true" />
                  : <Download size={16} aria-hidden="true" />}
                {copy.activation.confirm}
              </UiButton>
            </div>
          </DialogContent>
        )}
      </DialogRoot>
      <DialogRoot
        open={detailSkill != null}
        onOpenChange={(open) => {
          if (!open) setDetailEntryKey(null);
        }}
      >
        {detailSkill && (
          <DialogContent
            className="maka-modal maka-skill-dialog"
            aria-labelledby="maka-skill-diagnostics-title"
            showClose={false}
          >
            <DialogHeader
              icon={<Blocks aria-hidden="true" />}
              title={copy.details.title}
              subtitle={`${detailSkill.name} · ${detailSkill.id}`}
              titleId="maka-skill-diagnostics-title"
              closeLabel={copy.details.close}
              onClose={() => setDetailEntryKey(null)}
            />
            <div className="maka-skill-dialog-body">
              <SkillDetailField label={copy.details.status} value={formatSkillRuntimeLabel(detailSkill, copy)} />
              <SkillDetailField label={copy.details.source} value={copy.status.origin[detailSkill.discoveryOrigin]} />
              <SkillDetailField label={copy.details.path} value={detailSkill.displayPath} mono />
              <SkillDetailField label={copy.details.effective} value={detailSkill.effective ? copy.details.yes : copy.details.no} />
              {detailSkill.shadowedBy && (
                <div className="maka-skill-detail-field">
                  <span>{copy.details.shadowedBy}</span>
                  <UiButton
                    type="button"
                    variant="quiet"
                    size="sm"
                    onClick={() => setDetailEntryKey(detailSkill.shadowedBy ?? null)}
                  >
                    {detailSkill.shadowedBy}
                  </UiButton>
                </div>
              )}
              <SkillDetailField
                label={copy.details.issues}
                value={formatSkillIssues(detailSkill, copy)}
              />
              <SkillDetailField
                label={copy.details.requirements}
                value={formatSkillRequirements(detailSkill, copy)}
              />
              <p className="maka-skill-dialog-notice">{copy.details.declaredNotice}</p>
            </div>
            <div className="maka-skill-dialog-actions">
              <UiButton type="button" variant="secondary" onClick={() => setDetailEntryKey(null)}>
                {copy.details.close}
              </UiButton>
              {detailSkill.canOpen && props.onOpenSkill && (
                <UiButton
                  type="button"
                  onClick={() => void props.onOpenSkill?.(detailSkill.entryKey, detailSkill.repairTarget)}
                  disabled={props.actionBusy}
                >
                  <FileEdit size={15} aria-hidden="true" />
                  {detailSkill.repairTarget == null ? copy.row.openTitle : copy.row.openRepairTitle}
                </UiButton>
              )}
            </div>
          </DialogContent>
        )}
      </DialogRoot>
    </div>
  );
}

function SkillDetailField(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="maka-skill-detail-field">
      <span>{props.label}</span>
      <strong data-mono={props.mono ? 'true' : undefined}>{props.value}</strong>
    </div>
  );
}

function formatStringList(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

function formatSkillIssues(skill: SkillEntry, copy: SkillsCopy): string {
  if (skill.issues.length === 0) return copy.details.none;
  return skill.issues.map((issue) => issue.field ? `${issue.field}: ${issue.message}` : issue.message).join(' · ');
}

function formatSkillRequirements(skill: SkillEntry, copy: SkillsCopy): string {
  const values: string[] = [];
  if (skill.requiredTools.length > 0) values.push(`${copy.activation.requiredTools}: ${skill.requiredTools.join(', ')}`);
  if (skill.requiredCapabilities.length > 0) values.push(`${copy.activation.requiredCapabilities}: ${skill.requiredCapabilities.join(', ')}`);
  if (skill.missingRequiredTools.length > 0) values.push(copy.status.missingTools(skill.missingRequiredTools.join(', ')));
  if (skill.missingRequiredCapabilities.length > 0) values.push(copy.status.missingCapabilities(skill.missingRequiredCapabilities.join(', ')));
  if ((skill.declaredTools ?? []).length > 0) values.push(`${copy.activation.requestedTools}: ${(skill.declaredTools ?? []).join(', ')}`);
  return values.length > 0 ? values.join(' · ') : copy.details.none;
}

function formatSkillLibraryDescription(skill: SkillEntry, copy: SkillsCopy): string | undefined {
  const raw = skill.description?.trim();
  if (!raw) return undefined;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;

  const source = `${skill.id} ${skill.name} ${raw}`.toLowerCase();
  if (source.includes('docx') || source.includes('word') || source.includes('google docs')) {
    return copy.description.document;
  }
  if (source.includes('ppt') || source.includes('powerpoint') || source.includes('slide') || source.includes('presentation')) {
    return copy.description.presentation;
  }
  if (source.includes('spreadsheet') || source.includes('excel') || source.includes('csv') || source.includes('xlsx')) {
    return copy.description.spreadsheet;
  }
  if (source.includes('image') || source.includes('photo') || source.includes('bitmap')) {
    return copy.description.image;
  }
  if (source.includes('browser') || source.includes('chrome') || source.includes('web target')) {
    return copy.description.browser;
  }
  if (source.includes('macos') || source.includes('swiftui') || source.includes('appkit')) {
    return copy.description.macos;
  }
  return copy.description.fallback;
}

function formatSkillStatusLabel(skill: SkillEntry, copy: SkillsCopy): string {
  if (skill.validationStatus === 'metadata_error') return copy.status.metadataError;
  if (skill.sourceType === 'managed') {
    return copy.status.managed[skill.managedUpdateStatus ?? 'up_to_date'];
  }
  if (skill.userModified) return copy.status.modified;
  if (skill.sourceType === 'bundled') return copy.status.bundled;
  return copy.status.local;
}

function formatSkillRuntimeLabel(skill: SkillEntry, copy: SkillsCopy): string {
  return copy.status.operational[skill.operationalStatus];
}

function formatSkillLifecycleReason(skill: SkillEntry, copy: SkillsCopy): string | undefined {
  if (skill.operationalStatus === 'host_incompatible') {
    const reasons: string[] = [];
    if (skill.missingRequiredTools.length > 0) {
      reasons.push(copy.status.missingTools(skill.missingRequiredTools.join(', ')));
    }
    if (skill.missingRequiredCapabilities.length > 0) {
      reasons.push(copy.status.missingCapabilities(skill.missingRequiredCapabilities.join(', ')));
    }
    return reasons.join(' · ');
  }
  if (skill.operationalStatus === 'shadowed') {
    return skill.shadowedBy ? `${copy.status.shadowed} ${skill.shadowedBy}` : copy.status.shadowed;
  }
  if (skill.operationalStatus === 'state_error') return copy.status.stateFileError;
  const issue = skill.issues.find((candidate) => candidate.severity === 'error') ?? skill.issues[0];
  if (!issue) return undefined;
  if (issue.code === 'blocked_path') return copy.status.blockedPath;
  if (issue.code === 'unreadable_skill') return copy.status.unreadableSkill;
  const detail = issue.field ?? issue.code;
  return issue.severity === 'error'
    ? copy.status.invalidMetadata(detail)
    : copy.status.metadataWarning(detail);
}

function shouldShowSkillGovernanceChip(skill: SkillEntry): boolean {
  return skill.validationStatus === 'metadata_error'
    || skill.sourceType === 'managed'
    || skill.sourceType === 'bundled'
    || skill.userModified === true;
}

// Derive the source-status Chip tone from the same data-status the retired
// .maka-skill-library-status-label CSS keyed off. Exception-only: 内置 / 本地
// (expected states) stay neutral; only genuine attention states carry a tone.
//   metadata_error / local_modified → warning (needs the user's attention)
//   受管理 (managed base) → info (managed but nothing wrong)
//   bundled / workspace default → neutral
function skillStatusChipTone(skill: SkillEntry): ChipProps['variant'] {
  if (skill.validationStatus === 'metadata_error') return 'warning';
  if (skill.sourceType === 'managed') {
    if (skill.managedUpdateStatus === 'local_modified' || skill.managedUpdateStatus === 'metadata_error') return 'warning';
    return 'info';
  }
  return 'neutral';
}

function skillOperationalChipTone(skill: SkillEntry): ChipProps['variant'] {
  if (skill.operationalStatus === 'invalid' || skill.operationalStatus === 'state_error') return 'warning';
  if (skill.operationalStatus === 'host_incompatible' || skill.operationalStatus === 'shadowed') return 'info';
  return 'neutral';
}

function matchesSkillStatusFilter(skill: SkillEntry, filter: SkillStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'usable') return skill.operationalStatus === 'eligible';
  if (filter === 'attention') {
    return skill.operationalStatus === 'invalid' || skill.operationalStatus === 'state_error';
  }
  return skill.operationalStatus === 'disabled'
    || skill.operationalStatus === 'shadowed'
    || skill.operationalStatus === 'host_incompatible';
}

function countSkillsForFilter(skills: SkillEntry[], filter: SkillStatusFilter): number {
  return skills.filter((skill) => matchesSkillStatusFilter(skill, filter)).length;
}

export function SkillsModuleMain(props: {
  embedded?: boolean;
  skills?: SkillEntry[];
  skillHostBasis?: 'session' | 'desktop_default';
  bundledSkillCatalog?: BundledSkillCatalogEntry[];
  auditReport?: CapabilityAuditReport;
  onRefreshSkills?(): void | Promise<void>;
  onRefreshBundledSkillCatalog?(): void | Promise<void>;
  onOpenSkill?(entryKey: string, repairTarget: SkillEntry['repairTarget']): void | Promise<void>;
  onActivateBundledSkill?(id: string): boolean | Promise<boolean>;
  onSetSkillEnabled?(entryKey: string, enabled: boolean): boolean | Promise<boolean>;
}) {
  const copy = getSkillsCopy(useUiLocale());
  const [pendingSkillAction, setPendingSkillAction] = useState<string | null>(null);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const skillActionMountedRef = useMountedRef();
  const pendingSkillActionRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      pendingSkillActionRef.current = null;
    };
  }, []);

  async function runSkillAction<Result>(
    actionKey: string,
    action: (() => Result | Promise<Result>) | undefined,
  ) {
    if (!action || pendingSkillActionRef.current !== null) return undefined;
    pendingSkillActionRef.current = actionKey;
    setPendingSkillAction(actionKey);
    try {
      return await action();
    } finally {
      if (pendingSkillActionRef.current === actionKey) {
        pendingSkillActionRef.current = null;
        if (skillActionMountedRef.current) setPendingSkillAction(null);
      }
    }
  }

  const skillActionBusy = pendingSkillAction !== null;
  const auditReport = props.auditReport ?? deriveCapabilityAuditReport({ skills: props.skills ?? [] });
  const Root = props.embedded ? 'div' : 'main';
  return (
    <Root
      className="maka-main detailPane maka-module-main agents-chat-panel"
      data-module="skills"
      data-embedded={props.embedded ? 'true' : undefined}
      aria-label={copy.page.title}
    >
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title={copy.page.title}
        subtitle={copy.page.subtitle}
        actions={
        <div className="maka-module-main-actions" role="group" aria-label={copy.page.actions}>
          <label className="maka-skill-search" aria-label={copy.page.search}>
            <Search size={15} aria-hidden="true" />
            <Input
              unstyled
              value={skillSearchQuery}
              onChange={(event) => setSkillSearchQuery(event.currentTarget.value)}
              maxLength={120}
              placeholder={copy.page.search}
            />
          </label>
          <UiButton
            className="maka-skill-header-utility"
            variant="secondary"
            type="button"
            onClick={() => void runSkillAction('refresh', props.onRefreshSkills)}
            disabled={!props.onRefreshSkills || skillActionBusy}
          >
            {pendingSkillAction === 'refresh' ? copy.page.refreshing : copy.page.refresh}
          </UiButton>
        </div>
        }
      />
      <CapabilityAuditStrip report={auditReport} />
      <SkillLibraryPanel
        skills={props.skills}
        skillHostBasis={props.skillHostBasis}
        bundledSkillCatalog={props.bundledSkillCatalog}
        onRefreshSkills={props.onRefreshSkills ? () => runSkillAction('refresh', props.onRefreshSkills) : undefined}
        onOpenSkill={props.onOpenSkill ? (entryKey, repairTarget) => runSkillAction(`open:${entryKey}`, () => props.onOpenSkill?.(entryKey, repairTarget)) : undefined}
        onActivateBundledSkill={props.onActivateBundledSkill
          ? async (id) => (await runSkillAction(`bundled:activate:${id}`, () => props.onActivateBundledSkill!(id))) === true
          : undefined}
        onSetSkillEnabled={props.onSetSkillEnabled
          ? async (entryKey, enabled) => (await runSkillAction(
              `toggle:${entryKey}`,
              () => props.onSetSkillEnabled!(entryKey, enabled),
            )) === true
          : undefined}
        actionBusy={skillActionBusy}
        refreshPending={pendingSkillAction === 'refresh'}
        openingSkillId={pendingSkillAction?.startsWith('open:') ? pendingSkillAction.slice('open:'.length) : null}
        activatingBundledId={pendingSkillAction?.startsWith('bundled:activate:') ? pendingSkillAction.slice('bundled:activate:'.length) : null}
        togglingSkillEntryKey={pendingSkillAction?.startsWith('toggle:') ? pendingSkillAction.slice('toggle:'.length) : null}
        searchQuery={skillSearchQuery}
      />
    </Root>
  );
}
