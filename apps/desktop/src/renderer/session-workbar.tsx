import { useEffect, useState, type ReactNode } from 'react';
import {
  TaskLedgerPanel,
  deriveTaskLedgerPanelModel,
  useUiLocale,
  type ChatModelChoice,
} from '@maka/ui';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { Section } from '@astryxdesign/core/Section';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import type { SessionSummary } from '@maka/core';
import { ArtifactPane } from './artifact-pane';
import { BrowserPanel } from './browser-panel';
import { QuoteCompanionPanel } from './quote-companion-panel';
import { SessionInspectorPanel } from './session-inspector-panel';
import type { SessionWorkbarTab } from './session-workbar-layout';
import { useSessionTasks } from './use-session-tasks';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import type {
  CompanionQuoteTarget,
  CompanionQuoteSnapshot,
  QuoteCompanionPanelState,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

/**
 * One tab body. `Section` carries the surface; the class carries only what a
 * scroll parent needs (`min-height: 0`) and the `[hidden]` override, since an
 * Astryx Section sets its own `display`.
 */
function WorkbarPanel(props: { active: boolean; className?: string; children: ReactNode }) {
  return (
    <Section
      variant="transparent"
      padding={0}
      hidden={!props.active}
      className={
        props.className
          ? `maka-session-workbar-panel ${props.className}`
          : 'maka-session-workbar-panel'
      }
    >
      {props.children}
    </Section>
  );
}

/** A tab's count, in the shared Badge rather than a private pill. */
function TabCount(props: { count: number }) {
  return <Badge variant="neutral" label={props.count} data-maka-contract="session-workbar-count" />;
}

export function SessionWorkbar(props: {
  sessionId: string;
  browserLive: boolean;
  hidden: boolean;
  onDismiss: () => void;
  activeTab: SessionWorkbarTab;
  onActiveTabChange: (tab: SessionWorkbarTab) => void;
  /** Active quote side panel: staged excerpts for the source session, or null
   *  when no panel is open. Renders a transient "追问引用" tab. */
  quote?: QuoteCompanionPanelState | null;
  onClearQuote?: () => void;
  onQuotesConsumed?: (snapshot: CompanionQuoteSnapshot) => void;
  onRemoveQuote?: (target: CompanionQuoteTarget) => void;
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  /** The main session the companion forks from (inherits context + model). */
  sourceSession?: SessionSummary;
  /** Shared global choice list, used to label the companion's inherited model. */
  modelChoices?: readonly ChatModelChoice[];
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).workbar;
  const sessionTasks = useSessionTasks(props.sessionId);
  const taskCount = deriveTaskLedgerPanelModel(sessionTasks.tasks).activeCount;
  const [artifactCount, setArtifactCount] = useState(0);

  // The quote tab only exists while an excerpt is active; fall back when cleared.
  useEffect(() => {
    if (props.activeTab === 'quote' && !props.quote) props.onActiveTabChange('tasks');
  }, [props.activeTab, props.quote, props.onActiveTabChange]);

  return (
    <Card
      variant="transparent"
      padding={0}
      height="100%"
      className="maka-session-workbar"
      data-maka-contract="session-workbar"
      role="complementary"
      aria-label={copy.ariaLabel}
    >
      <Toolbar
        className="maka-session-workbar-toolbar"
        label={copy.sectionsAriaLabel}
        size="sm"
        /* No `dividers`: the column is its own surface tone now, so the tab
           row needs no rule to sit apart from the body — and the tab strip
           already draws its own baseline under the selected tab. */
        startContent={
          <TabList
            className="maka-session-workbar-tab-list"
            value={props.activeTab}
            onChange={(value) => props.onActiveTabChange(value as SessionWorkbarTab)}
            size="sm"
            layout="fill"
            aria-label={copy.sectionsAriaLabel}
          >
            <Tab value="tasks" label={copy.tasks} endContent={<TabCount count={taskCount} />} />
            <Tab value="browser" label={copy.browser} />
            <Tab value="files" label={copy.files} endContent={<TabCount count={artifactCount} />} />
            <Tab value="inspector" label={copy.inspector} />
            {props.quote && <Tab value="quote" label={copy.quoteTab} />}
          </TabList>
        }
      />
      <WorkbarPanel active={props.activeTab === 'tasks'}>
        <TaskLedgerPanel
          tasks={sessionTasks.tasks}
          loading={sessionTasks.loading}
          error={sessionTasks.error}
          onRetry={sessionTasks.retry}
        />
      </WorkbarPanel>
      <WorkbarPanel active={props.activeTab === 'browser'}>
        <BrowserPanel
          sessionId={props.sessionId}
          hidden={props.hidden || props.activeTab !== 'browser'}
        />
      </WorkbarPanel>
      <WorkbarPanel active={props.activeTab === 'files'}>
        <ArtifactPane
          sessionId={props.sessionId}
          onCountChange={setArtifactCount}
          onDismiss={props.onDismiss}
        />
      </WorkbarPanel>
      <WorkbarPanel active={props.activeTab === 'inspector'}>
        <SessionInspectorPanel
          sessionId={props.sessionId}
          active={!props.hidden && props.activeTab === 'inspector'}
        />
      </WorkbarPanel>
      {props.quote && (
        <WorkbarPanel active={props.activeTab === 'quote'} className="maka-quote-workbar-panel">
          <QuoteCompanionPanel
            key={props.quote.id}
            panelId={props.quote.id}
            quotes={props.quote.quotes}
            sourceSession={props.sourceSession}
            modelChoices={props.modelChoices ?? []}
            onClear={props.onClearQuote}
            onQuotesConsumed={props.onQuotesConsumed ?? (() => {})}
            onRemoveQuote={props.onRemoveQuote}
            onForkVisibilityChange={props.onForkVisibilityChange}
          />
        </WorkbarPanel>
      )}
    </Card>
  );
}
