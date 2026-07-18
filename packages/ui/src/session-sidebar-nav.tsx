import type { PlanReminder } from '@maka/core';
import { Blocks, CalendarCheck, ChevronDown, ChevronRight, Settings, SquarePen, Timer } from './icons.js';
import type { NavSelection } from './nav-selection.js';
import { cn } from './ui.js';
import { cva } from 'class-variance-authority';
import { Button as BaseButton } from '@base-ui/react/button';
import { useId, useState } from 'react';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';

const navRowVariants = cva(
  [
    'min-h-[var(--h-control-lg)] gap-2 rounded-sm border-0 bg-transparent px-1.5 py-0.5',
    'text-left text-sm font-medium text-[var(--foreground-secondary)]',
    // Glyphs pin to the 80%-ink chrome tone (same as titlebar icon actions)
    // instead of inheriting: the darwin glass override forces row TEXT to
    // full foreground, and icons must not follow it.
    '[&_.maka-nav-icon]:text-[var(--foreground-secondary)]',
    'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)]',
    'hover:bg-[var(--state-hover-bg)] hover:text-foreground',
    'data-[active=true]:bg-[var(--state-selected-bg)] data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:shadow-none',
    'data-[active=true]:[&_.maka-nav-icon]:text-foreground',
    '[&_.maka-nav-count]:bg-[var(--state-hover-bg)] [&_.maka-nav-count]:text-[var(--muted-foreground)]',
    'data-[active=true]:[&_.maka-nav-count]:bg-[var(--state-selected-bg)] data-[active=true]:[&_.maka-nav-count]:text-foreground',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-55 aria-disabled:hover:bg-transparent',
    'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-55 data-[disabled=true]:hover:bg-transparent',
  ],
  {
    variants: {
      tone: {
        default: '',
        newTask: 'text-foreground',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

type ModuleNavId = 'daily-review' | 'skills' | 'mcp' | 'automations';

const settingsButtonClass =
  'w-full min-w-0 gap-2 rounded-sm border-0 bg-transparent px-1.5 py-1.5 ' +
  'text-left text-sm font-medium text-[var(--foreground-secondary)] ' +
  'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)] ' +
  'hover:bg-[var(--state-hover-bg)] hover:text-foreground';

export function SessionSidebarNav(props: {
  selection: NavSelection;
  planReminders?: PlanReminder[];
  onSelect(selection: NavSelection): void;
  onNew(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const extensionsTreeId = useId();
  const [extensionsOpen, setExtensionsOpen] = useState(true);
  const moduleNavLabel: Record<ModuleNavId, string> = {
    automations: copy.automations,
    skills: copy.skills,
    mcp: copy.mcp,
    'daily-review': copy.dailyReview,
  };
  const isModuleActive = (id: ModuleNavId) => props.selection.section === id;
  const activePlanReminderCount = (props.planReminders ?? []).filter(
    (reminder) => reminder.status !== 'completed',
  ).length;

  function selectModule(id: ModuleNavId) {
    props.onSelect({ section: id });
  }

  return (
    <nav className="maka-sidebar-modules" aria-label={copy.mainLabel}>
      <BaseButton
        className={cn('maka-nav-row maka-nav-new-task', navRowVariants({ tone: 'newTask' }))}
        aria-label={copy.newTask}
        type="button"
        onClick={props.onNew}
      >
        <SquarePen className="maka-nav-icon" aria-hidden="true" />
        <span>{copy.newTask}</span>
        <kbd className="maka-nav-kbd" aria-hidden="true">
          ⌘ N
        </kbd>
      </BaseButton>
      <div className="maka-sidebar-nav-group" data-open={extensionsOpen ? 'true' : 'false'}>
        <BaseButton
          className={cn('maka-nav-row maka-nav-extension-toggle', navRowVariants())}
          data-expanded={extensionsOpen ? 'true' : 'false'}
          aria-expanded={extensionsOpen}
          aria-controls={extensionsTreeId}
          type="button"
          onClick={() => setExtensionsOpen((open) => !open)}
        >
          <span className="maka-nav-extension-glyph" aria-hidden="true">
            <Blocks className="maka-nav-icon maka-nav-extension-default-icon" />
            <ChevronRight className="maka-nav-icon maka-nav-extension-hover-icon" />
            <ChevronDown className="maka-nav-icon maka-nav-extension-open-icon" />
          </span>
          <span>{copy.extensions}</span>
        </BaseButton>
        <div
          id={extensionsTreeId}
          className="maka-sidebar-nav-tree"
          role="group"
          aria-label={copy.extensions}
          hidden={!extensionsOpen}
        >
          <BaseButton
            className={cn('maka-nav-row maka-nav-tree-row', navRowVariants())}
            data-active={isModuleActive('skills')}
            aria-current={isModuleActive('skills') ? 'page' : undefined}
            aria-label={moduleNavLabel.skills}
            type="button"
            onClick={() => selectModule('skills')}
          >
            <span>{moduleNavLabel.skills}</span>
          </BaseButton>
          <BaseButton
            className={cn('maka-nav-row maka-nav-tree-row', navRowVariants())}
            data-active={isModuleActive('mcp')}
            aria-current={isModuleActive('mcp') ? 'page' : undefined}
            aria-label={moduleNavLabel.mcp}
            type="button"
            onClick={() => selectModule('mcp')}
          >
            <span>{moduleNavLabel.mcp}</span>
          </BaseButton>
        </div>
      </div>
      <BaseButton
        className={cn('maka-nav-row', navRowVariants())}
        data-active={isModuleActive('daily-review')}
        aria-current={isModuleActive('daily-review') ? 'page' : undefined}
        aria-label={moduleNavLabel['daily-review']}
        type="button"
        onClick={() => selectModule('daily-review')}
      >
        <CalendarCheck className="maka-nav-icon" aria-hidden="true" />
        <span>{moduleNavLabel['daily-review']}</span>
      </BaseButton>
      <BaseButton
        className={cn('maka-nav-row', navRowVariants())}
        data-active={isModuleActive('automations')}
        aria-current={isModuleActive('automations') ? 'page' : undefined}
        type="button"
        onClick={() => selectModule('automations')}
        aria-label={
          activePlanReminderCount > 0 ? copy.pendingReminders(activePlanReminderCount) : moduleNavLabel.automations
        }
      >
        <Timer className="maka-nav-icon" aria-hidden="true" />
        <span>{moduleNavLabel.automations}</span>
        {activePlanReminderCount > 0 && (
          <small className="maka-nav-count" aria-hidden="true">
            {activePlanReminderCount}
          </small>
        )}
      </BaseButton>
    </nav>
  );
}

export function SessionSidebarFooter(props: { onOpenSettings(): void }) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  return (
    <footer className="maka-session-panel-footer">
      <BaseButton
        className={cn('maka-sidebar-settings-button', settingsButtonClass)}
        type="button"
        onClick={props.onOpenSettings}
        aria-label={copy.settings}
        title={copy.settings}
      >
        <Settings className="maka-nav-icon" aria-hidden="true" />
        <span>{copy.settings}</span>
      </BaseButton>
    </footer>
  );
}
