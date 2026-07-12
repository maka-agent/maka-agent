import type { PlanReminder } from '@maka/core';
import { Blocks, CalendarCheck, Settings, SquarePen, Timer } from './icons.js';
import type { NavSelection } from './nav-selection.js';
import { Button as UiButton, cn } from './ui.js';
import { cva } from 'class-variance-authority';

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

type ModuleNavId = 'daily-review' | 'skills' | 'automations';

const settingsButtonClass =
  'w-full min-w-0 gap-2 rounded-sm border-0 bg-transparent px-1.5 py-1.5 ' +
  'text-left text-sm font-medium text-[var(--foreground-secondary)] ' +
  'transition-[background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out-strong)] ' +
  'hover:bg-[var(--state-hover-bg)] hover:text-foreground';

const MODULE_NAV_LABEL: Record<ModuleNavId, string> = {
  automations: '定时任务',
  skills: '技能',
  'daily-review': '每日回顾',
};

export function SessionSidebarNav(props: {
  selection: NavSelection;
  planReminders?: PlanReminder[];
  onSelect(selection: NavSelection): void;
  onNew(): void;
}) {
  const isModuleActive = (id: ModuleNavId) => props.selection.section === id;
  const activePlanReminderCount = (props.planReminders ?? [])
    .filter((reminder) => reminder.status !== 'completed')
    .length;

  function selectModule(id: ModuleNavId) {
    props.onSelect({ section: id });
  }

  return (
    <nav className="maka-sidebar-modules" aria-label="主导航">
      <UiButton
        variant="quiet"
        size="nav"
        className={cn('maka-nav-row maka-nav-new-task', navRowVariants({ tone: 'newTask' }))}
        aria-label="新任务"
        type="button"
        onClick={props.onNew}
      >
        <SquarePen className="maka-nav-icon" aria-hidden="true" />
        <span>新任务</span>
        <kbd className="maka-nav-kbd" aria-hidden="true">⌘ N</kbd>
      </UiButton>
      <UiButton
        variant="quiet"
        size="nav"
        className={cn('maka-nav-row', navRowVariants())}
        data-active={isModuleActive('daily-review')}
        aria-current={isModuleActive('daily-review') ? 'page' : undefined}
        aria-label={MODULE_NAV_LABEL['daily-review']}
        type="button"
        onClick={() => selectModule('daily-review')}
      >
        <CalendarCheck className="maka-nav-icon" aria-hidden="true" />
        <span>{MODULE_NAV_LABEL['daily-review']}</span>
      </UiButton>
      <UiButton
        variant="quiet"
        size="nav"
        className={cn('maka-nav-row', navRowVariants())}
        data-active={isModuleActive('skills')}
        aria-current={isModuleActive('skills') ? 'page' : undefined}
        aria-label={MODULE_NAV_LABEL.skills}
        type="button"
        onClick={() => selectModule('skills')}
      >
        <Blocks className="maka-nav-icon" aria-hidden="true" />
        <span>{MODULE_NAV_LABEL.skills}</span>
      </UiButton>
      <UiButton
        variant="quiet"
        size="nav"
        className={cn('maka-nav-row', navRowVariants())}
        data-active={isModuleActive('automations')}
        aria-current={isModuleActive('automations') ? 'page' : undefined}
        type="button"
        onClick={() => selectModule('automations')}
        aria-label={activePlanReminderCount > 0 ? `定时任务，${activePlanReminderCount} 个未完成提醒` : MODULE_NAV_LABEL.automations}
      >
        <Timer className="maka-nav-icon" aria-hidden="true" />
        <span>{MODULE_NAV_LABEL.automations}</span>
        {activePlanReminderCount > 0 && (
          <small className="maka-nav-count" aria-hidden="true">{activePlanReminderCount}</small>
        )}
      </UiButton>
    </nav>
  );
}

export function SessionSidebarFooter(props: { onOpenSettings(): void }) {
  return (
    <footer className="maka-session-panel-footer">
      <UiButton
        className={cn('maka-sidebar-settings-button', settingsButtonClass)}
        variant="quiet"
        size="nav"
        type="button"
        onClick={props.onOpenSettings}
        aria-label="设置"
        title="设置"
      >
        <Settings className="maka-nav-icon" aria-hidden="true" />
        <span>设置</span>
      </UiButton>
    </footer>
  );
}
