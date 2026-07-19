import { useEffect, useState, type CSSProperties } from 'react';
import {
  PrimitiveTabs,
  PrimitiveTabsList,
  PrimitiveTabsPanel,
  PrimitiveTabsTrigger,
  TaskLedgerPanel,
  deriveTaskLedgerPanelModel,
  useUiLocale,
} from '@maka/ui';
import { ArtifactPane } from './artifact-pane';
import { BrowserPanel } from './browser-panel';
import type { SessionWorkbarTab } from './session-workbar-layout';
import { useSessionTasks } from './use-session-tasks';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export function SessionWorkbar(props: {
  sessionId: string;
  browserLive: boolean;
  hidden: boolean;
  width: number;
  onDismiss: () => void;
  activeTab: SessionWorkbarTab;
  onActiveTabChange: (tab: SessionWorkbarTab) => void;
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).workbar;
  const sessionTasks = useSessionTasks(props.sessionId);
  const taskCount = deriveTaskLedgerPanelModel(sessionTasks.tasks).activeCount;
  const [artifactCount, setArtifactCount] = useState(0);

  useEffect(() => {
    if (props.activeTab === 'browser' && !props.browserLive) props.onActiveTabChange('tasks');
  }, [props.activeTab, props.browserLive, props.onActiveTabChange]);

  return (
    <aside
      className="maka-session-workbar"
      aria-label={copy.ariaLabel}
      style={{ '--maka-session-workbar-width': `${props.width}px` } as CSSProperties}
    >
      <PrimitiveTabs value={props.activeTab} onValueChange={(value) => props.onActiveTabChange(value as SessionWorkbarTab)} className="maka-session-workbar-tabs">
        <PrimitiveTabsList variant="underline" className="maka-session-workbar-tab-list" aria-label={copy.sectionsAriaLabel}>
          <PrimitiveTabsTrigger value="tasks">
            <span>{copy.tasks}</span>
            <span className="maka-session-workbar-count">{taskCount}</span>
          </PrimitiveTabsTrigger>
          <PrimitiveTabsTrigger value="browser" disabled={!props.browserLive}>
            <span>{copy.browser}</span>
          </PrimitiveTabsTrigger>
          <PrimitiveTabsTrigger value="files">
            <span>{copy.files}</span>
            <span className="maka-session-workbar-count">{artifactCount}</span>
          </PrimitiveTabsTrigger>
        </PrimitiveTabsList>
        <PrimitiveTabsPanel value="tasks" className="maka-session-workbar-panel" keepMounted>
          <TaskLedgerPanel
            tasks={sessionTasks.tasks}
            loading={sessionTasks.loading}
            error={sessionTasks.error}
            onRetry={sessionTasks.retry}
          />
        </PrimitiveTabsPanel>
        <PrimitiveTabsPanel value="browser" className="maka-session-workbar-panel" keepMounted>
          {props.browserLive && <BrowserPanel sessionId={props.sessionId} hidden={props.hidden || props.activeTab !== 'browser'} />}
        </PrimitiveTabsPanel>
        <PrimitiveTabsPanel value="files" className="maka-session-workbar-panel" keepMounted>
          <ArtifactPane sessionId={props.sessionId} onCountChange={setArtifactCount} onDismiss={props.onDismiss} />
        </PrimitiveTabsPanel>
      </PrimitiveTabs>
    </aside>
  );
}
