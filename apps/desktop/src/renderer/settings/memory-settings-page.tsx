import type { AppSettings, UpdateAppSettingsResult } from '@maka/core';
import { Alert, AlertDescription, Button, Chip, Input, RelativeTime, SettingsSwitch as Switch, Textarea } from '@maka/ui';
import { SettingsRows } from './settings-rows';
import { MemoryEntryList } from './memory-entry-list';
import { MemoryPromptPreviewSection, WorkspaceInstructionsSection } from './memory-settings-sections';
import { useMemoryDocumentController } from './use-memory-settings-controller';
import { useWorkspaceInstructionsController } from './use-workspace-instructions-controller';
import {
  displayMemoryPath,
  localMemoryBackupKindLabel,
  localMemoryBackupSummary,
  memoryStatusLabel,
  memoryStatusTone,
} from './memory-settings-labels';

export function MemorySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
}) {
  const {
    draft,
    setDraft,
    newMemoryTitle,
    setNewMemoryTitle,
    newMemoryTags,
    setNewMemoryTags,
    newMemoryContent,
    setNewMemoryContent,
    memoryEntryQuery,
    setMemoryEntryQuery,
    lastSaveSummary,
    pendingMemoryWriteAction,
    pendingMemoryActions,
    editorRef,
    reloadDraftFromDisk,
    setEnabled,
    setAgentReadEnabled,
    save,
    reset,
    restoreLatestBackup,
    restoreBackupCandidate,
    openFile,
    openLatestBackup,
    openBackupCandidate,
    openFolder,
    copyPath,
    copyBackupReference,
    copyLatestBackupReference,
    copyMemoryEntryReference,
    focusMemoryEntryInDraft,
    addManualMemoryDraftEntry,
    updateMemoryEntryStatus,
    effective,
    memoryDraftDirty,
    visibleMemoryEntries,
    memoryEntryPreviewBlockedReason,
    normalizedMemoryEntryQuery,
    filteredActiveEntries,
    filteredArchivedEntries,
    filteredEntryCount,
    localMemoryPromptPreview,
    promptPreviewBlockedReason,
    promptPreviewWillInject,
    localMemoryPromptPreviewBudgetLabel,
    memoryDraftHasSensitiveFields,
    memoryControlsDisabled: memoryDocumentControlsDisabled,
    isMemoryActionPending,
    copyLocalMemoryPromptPreview,
  } = useMemoryDocumentController({
    settings: props.settings,
    onReloadSettings: props.onReloadSettings,
  });
  const workspaceInstructions = useWorkspaceInstructionsController({
    onUpdate: props.onUpdate,
    onReloadSettings: props.onReloadSettings,
  });
  const memoryControlsDisabled = memoryDocumentControlsDisabled || workspaceInstructions.busy;

  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <div className="settingsFormRow">
          <div>
            <strong>本地 MEMORY.md</strong>
            <small>透明 Markdown 文件，保存在当前本机工作区。这里的内容不会自动从聊天里抽取。</small>
          </div>
          <Chip variant={memoryStatusTone(effective.status)}>
            {memoryStatusLabel(effective.status)}
          </Chip>
          <Switch
            ariaLabel="启用本地 MEMORY.md"
            checked={effective.enabled}
            disabled={memoryControlsDisabled}
            onChange={(enabled) => void setEnabled(enabled)}
          />
        </div>

        <div className="settingsFormRow">
          <div>
            <strong>模型上下文可读取</strong>
            <small>默认关闭。开启后才允许发送消息时把本地记忆加入 prompt；隐身模式下仍会禁用。</small>
          </div>
          <Switch
            ariaLabel="允许模型上下文读取本地记忆"
            checked={effective.agentReadEnabled}
            disabled={memoryControlsDisabled || !effective.enabled}
            onChange={(enabled) => void setAgentReadEnabled(enabled)}
          />
        </div>

        <div className="settingsFormRow">
          <div>
            <strong>项目指令文件</strong>
            <small>读取当前工作区的 AGENTS.md / CLAUDE.md / GEMINI.md；按低优先级指令注入，可随时关闭。</small>
          </div>
          <Switch
            ariaLabel="启用项目指令文件"
            checked={props.settings.workspaceInstructions.enabled}
            disabled={memoryControlsDisabled}
            onChange={(enabled) => void workspaceInstructions.setEnabled(enabled)}
          />
        </div>
      </SettingsRows>

      <WorkspaceInstructionsSection
        state={workspaceInstructions.state}
        disabled={memoryControlsDisabled}
        isActionPending={workspaceInstructions.isActionPending}
        onOpen={workspaceInstructions.openFile}
        onCreate={workspaceInstructions.createFile}
      />

      <div className="settingsConnectionMeta settingsMemoryMeta">
        <span className="settingsMemoryPath" title={effective.path || undefined}>
          {effective.path ? displayMemoryPath(effective.path) : '等待创建 MEMORY.md'}
        </span>
        {effective.latestBackup ? (
          <span className="settingsMemoryBackupState">
            上一版 {localMemoryBackupKindLabel(effective.latestBackup.kind)} · {localMemoryBackupSummary(effective.latestBackup)} · <RelativeTime ts={effective.latestBackup.updatedAt} />
          </span>
        ) : (
          <span className="settingsMemoryBackupState" data-empty="true">等待生成上一版备份</span>
        )}
        <span className="settingsMemoryDirtyState" data-dirty={memoryDraftDirty ? 'true' : 'false'}>
          {memoryDraftDirty ? '有未保存修改' : '草稿已保存'}
        </span>
        <span>
          {memoryDraftDirty ? '草稿 ' : ''}
          {visibleMemoryEntries.activeEntries.length} 条生效
        </span>
        {visibleMemoryEntries.archivedEntries.length > 0 && (
          <span>
            {memoryDraftDirty ? '草稿 ' : ''}
            {visibleMemoryEntries.archivedEntries.length} 条已归档
          </span>
        )}
      </div>

      {effective.backups && effective.backups.length > 1 && (
        <div className="settingsMemoryBackupList" role="status">
          <strong>备份候选</strong>
          {/* PR-MEMORY-BACKUP-LIST-A11Y-0 (round 16/30): same
              fix as round-7 daily-review archive list. Was
              `<div role="list">` with `<span role="listitem">`
              children — invalid layering (a span is not a list,
              and a listitem on a span has no list context to
              attach to). Switched to semantic <ul>/<li> so
              screen readers get the relationship from the
              elements themselves. */}
          <ul className="settingsMemoryBackupCandidates" aria-label="本地记忆备份候选列表">
            {effective.backups.map((backup) => {
              const backupCandidateLabel = `${localMemoryBackupKindLabel(backup.kind)} · ${localMemoryBackupSummary(backup)}`;
              return (
                <li key={`${backup.kind}:${backup.path}`} className="settingsMemoryBackupCandidate">
                  <span>{backupCandidateLabel} · <RelativeTime ts={backup.updatedAt} /></span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`打开备份候选 ${backupCandidateLabel}`}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:open`)}
                    onClick={() => void openBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:open`) ? '打开中…' : '打开'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`恢复备份候选 ${backupCandidateLabel}`}
                    disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending(`backup:${backup.kind}:restore`)}
                    onClick={() => void restoreBackupCandidate(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:restore`) ? '恢复中…' : '恢复'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-w-[4rem]"
                    aria-label={`复制备份候选引用 ${backupCandidateLabel}`}
                    disabled={isMemoryActionPending(`backup:${backup.kind}:copy`)}
                    onClick={() => void copyBackupReference(backup)}
                  >
                    {isMemoryActionPending(`backup:${backup.kind}:copy`) ? '复制中…' : '复制引用'}
                  </Button>
                </li>
              );
            })}
          </ul>
          <small>上一版操作会使用最近的候选；这里只显示 metadata，不展示备份正文。</small>
        </div>
      )}

      {lastSaveSummary && !memoryDraftDirty && (
        <div className="settingsMemorySaveSummary" role="status">
          <strong>{lastSaveSummary.title}</strong>
          <small className="settingsMemorySaveSummaryTime">
            保存于 <RelativeTime ts={lastSaveSummary.savedAt} />
          </small>
          <small>{lastSaveSummary.detail}</small>
        </div>
      )}

      {memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryEntryPreviewNotice" role="status">
          <strong>草稿条目预览暂停</strong>
          <small>{memoryEntryPreviewBlockedReason}</small>
        </div>
      )}

      <MemoryPromptPreviewSection
        active={promptPreviewWillInject}
        preview={localMemoryPromptPreview}
        budgetLabel={localMemoryPromptPreviewBudgetLabel}
        blockedReason={promptPreviewBlockedReason}
        safeMode={effective.status === 'safe_mode'}
        copyPending={isMemoryActionPending('memory:prompt-preview:copy')}
        onCopy={copyLocalMemoryPromptPreview}
      />

      {visibleMemoryEntries.entries.length > 0 && (
        <>
          <div className="settingsMemoryFilter">
            <Input
              type="search"
              value={memoryEntryQuery}
              onChange={(event) => setMemoryEntryQuery(event.currentTarget.value)}
              aria-label="筛选本地记忆"
              placeholder="筛选标题、内容、ID 或标签"
            />
            {normalizedMemoryEntryQuery ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setMemoryEntryQuery('')}
              >
                清除
              </Button>
            ) : null}
            <small>
              {normalizedMemoryEntryQuery
                ? `${filteredEntryCount} / ${visibleMemoryEntries.entries.length} 条匹配`
                : `${visibleMemoryEntries.entries.length} 条记忆`}
            </small>
          </div>
          {normalizedMemoryEntryQuery && filteredEntryCount === 0 ? (
            <div className="settingsMemoryFilterEmpty" role="status">
              <strong>没有匹配的记忆条目</strong>
              <small>筛选不会修改 MEMORY.md；清除筛选后会恢复显示全部条目。</small>
            </div>
          ) : (
            <div className="settingsMemoryEntryGroups">
              <MemoryEntryList
                title="生效记忆"
                entries={filteredActiveEntries}
                filtered={normalizedMemoryEntryQuery.length > 0}
                draftDirty={memoryDraftDirty}
                busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                pendingCopyIds={pendingMemoryActions}
                onCopyReference={copyMemoryEntryReference}
                onFocusDraft={focusMemoryEntryInDraft}
                onStatusChange={updateMemoryEntryStatus}
              />
              {visibleMemoryEntries.archivedEntries.length > 0 && (
                <MemoryEntryList
                  title="已归档记忆"
                  entries={filteredArchivedEntries}
                  filtered={normalizedMemoryEntryQuery.length > 0}
                  archived
                  draftDirty={memoryDraftDirty}
                  busy={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
                  pendingCopyIds={pendingMemoryActions}
                  onCopyReference={copyMemoryEntryReference}
                  onFocusDraft={focusMemoryEntryInDraft}
                  onStatusChange={updateMemoryEntryStatus}
                />
              )}
            </div>
          )}
        </>
      )}

      {visibleMemoryEntries.entries.length === 0 && !memoryEntryPreviewBlockedReason && (
        <div className="settingsMemoryListEmpty" role="status">
          <strong>等待添加记忆条目</strong>
          <small>手动添加会先进入下方草稿；保存后才会写入 MEMORY.md。</small>
        </div>
      )}

      <div className="settingsMemoryManualAdd" role="group" aria-label="手动添加本地记忆">
        <div className="settingsMemoryManualAddHeader">
          <strong>手动添加记忆</strong>
          <small>只追加到下方草稿；保存前仍可检查和修改 Markdown。</small>
        </div>
        <div className="settingsMemoryManualAddGrid">
          <Input
            type="text"
            value={newMemoryTitle}
            onChange={(event) => setNewMemoryTitle(event.currentTarget.value)}
            aria-label="记忆标题"
            placeholder="标题"
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <Input
            type="text"
            value={newMemoryTags}
            onChange={(event) => setNewMemoryTags(event.currentTarget.value)}
            aria-label="记忆标签"
            placeholder="标签（逗号分隔，可选）"
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
          <Textarea
            value={newMemoryContent}
            onChange={(event) => setNewMemoryContent(event.currentTarget.value)}
            aria-label="记忆内容"
            placeholder="内容"
            rows={3}
            disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          onClick={addManualMemoryDraftEntry}
        >
          添加到草稿
        </Button>
      </div>

      {memoryDraftHasSensitiveFields && (
        <div className="settingsMemoryDraftWarning" role="status">
          <strong>草稿含疑似敏感字段</strong>
          <small>保存时会先遮蔽疑似 token、API key 或密码，再写入 MEMORY.md。</small>
        </div>
      )}

      <label className="settingsMemoryEditor">
        <span>文件内容</span>
        <Textarea
          ref={editorRef}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          disabled={memoryControlsDisabled || effective.status === 'incognito_blocked' || !effective.enabled}
          rows={12}
          spellCheck={false}
          aria-label="MEMORY.md 内容"
        />
      </label>

      {effective.reason && (
        <Alert variant="passive" role="status">
          <AlertDescription>{effective.reason}</AlertDescription>
        </Alert>
      )}

      <div className="settingsActionRow" role="group" aria-label="MEMORY.md 文件操作">
        <Button type="button" className="min-w-[3.5rem]" disabled={memoryControlsDisabled || !effective.enabled || !memoryDraftDirty} onClick={() => void save()}>
          {pendingMemoryWriteAction === 'save' ? '保存中…' : memoryDraftDirty ? '保存' : '已保存'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[7.5rem]" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:file:open')} onClick={() => void openFile()}>
          {isMemoryActionPending('memory:file:open') ? '打开中…' : '打开 MEMORY.md'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[6rem]" disabled={memoryControlsDisabled || !effective.enabled || isMemoryActionPending('memory:folder:open')} onClick={() => void openFolder()}>
          {isMemoryActionPending('memory:folder:open') ? '打开中…' : '打开所在目录'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[4rem]" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reloadDraftFromDisk()}>
          {pendingMemoryWriteAction === 'reload' ? '载入中…' : '重新载入'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:open')} onClick={() => void openLatestBackup()}>
          {isMemoryActionPending('backup:latest:open') ? '打开中…' : '打开上一版'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[4rem]" disabled={!effective.path || isMemoryActionPending('memory:path:copy')} onClick={() => void copyPath()}>
          {isMemoryActionPending('memory:path:copy') ? '复制中…' : '复制路径'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[7rem]" disabled={!effective.latestBackup || (effective.latestBackup ? isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) : false)} onClick={() => void copyLatestBackupReference()}>
          {effective.latestBackup && isMemoryActionPending(`backup:${effective.latestBackup.kind}:copy`) ? '复制中…' : '复制上一版引用'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled} onClick={() => void reset()}>
          {pendingMemoryWriteAction === 'reset' ? '重置中…' : '重置并备份'}
        </Button>
        <Button type="button" variant="ghost" className="min-w-[5rem]" disabled={memoryControlsDisabled || !effective.enabled || !effective.latestBackup || isMemoryActionPending('backup:latest:restore')} onClick={() => void restoreLatestBackup()}>
          {isMemoryActionPending('backup:latest:restore') ? '恢复中…' : '恢复上一版'}
        </Button>
      </div>
    </div>
  );
}
