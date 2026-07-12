import type { LocalMemoryState } from '@maka/core';
import { Button, RelativeTime } from '@maka/ui';
import { memoryOriginLabel } from './memory-settings-labels';

export function MemoryEntryList(props: {
  title: string;
  entries: LocalMemoryState['activeEntries'];
  filtered?: boolean;
  archived?: boolean;
  draftDirty?: boolean;
  busy?: boolean;
  pendingCopyIds?: ReadonlySet<string>;
  onCopyReference?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onFocusDraft?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onStatusChange?(entry: LocalMemoryState['activeEntries'][number], status: 'active' | 'archived'): void | Promise<void>;
}) {
  return (
    <section className="settingsMemoryEntryGroup" data-archived={props.archived ? 'true' : 'false'}>
      <div className="settingsMemoryEntryGroupHeader">
        <strong>{props.title}</strong>
        <span>{props.entries.length} 条</span>
      </div>
      {props.draftDirty && props.onStatusChange && (
        <p className="settingsMemoryEntryDraftNotice" role="status">
          当前归档/恢复操作只更新草稿，保存后才会写入 MEMORY.md。
        </p>
      )}
      {props.entries.length === 0 ? (
        <p className="settingsMemoryEntryEmpty">{props.filtered ? '无匹配条目。' : '暂无条目。'}</p>
      ) : (
        /* PR-MEMORY-ENTRY-LIST-A11Y-0 (round 18/30): fourth
           application of the same ARIA list fix. Was `<div
           role="list">` with `<article role="listitem">` rows —
           semantic `<ul>` / `<li>` so screen readers get the
           relationship from the elements themselves. The inner
           `<article>` per entry stays — articles are valid
           sectioning content inside list items. */
        <ul className="settingsMemoryEntryList" aria-label={`${props.title}列表`}>
          {props.entries.map((entry) => {
            const copyPending = props.pendingCopyIds?.has(`entry:${entry.id}:copy`) ?? false;
            const statusActionLabel = props.draftDirty
              ? props.archived
                ? '恢复到草稿'
                : '归档到草稿'
              : props.archived
                ? '恢复'
                : '归档';
            const statusActionAriaLabel = props.draftDirty
              ? `${statusActionLabel}，保存前不会写入 MEMORY.md`
              : undefined;
            return (
              <li key={entry.id}>
                <article className="settingsMemoryEntryCard">
                <strong>{entry.title}</strong>
                <small className="settingsMemoryEntryMeta">
                  {memoryOriginLabel(entry.origin)}
                  {entry.tags.length > 0 ? ` · ${entry.tags.join(' / ')}` : ''}
                </small>
                <small className="settingsMemoryEntryFacts">
                  <span>ID {entry.id}</span>
                  {entry.createdAt !== undefined && (
                    <span>
                      创建 <RelativeTime ts={entry.createdAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                  {entry.updatedAt !== undefined && (
                    <span>
                      更新 <RelativeTime ts={entry.updatedAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                </small>
                <span className="settingsMemoryPromptScope" data-active={props.archived ? 'false' : 'true'}>
                  {props.archived ? '已归档，不进入 prompt' : '生效条目，会进入本地记忆 prompt'}
                </span>
                <p>{entry.content}</p>
                {(props.onCopyReference || props.onFocusDraft || props.onStatusChange) && (
                  <div className="settingsMemoryEntryActions" role="group" aria-label={`${entry.title}记忆操作`}>
                    {props.onCopyReference && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-[4rem]"
                        disabled={copyPending}
                        onClick={() => void props.onCopyReference?.(entry)}
                      >
                        {copyPending ? '复制中…' : '复制引用'}
                      </Button>
                    )}
                    {props.onFocusDraft && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void props.onFocusDraft?.(entry)}
                      >
                        定位草稿
                      </Button>
                    )}
                    {props.onStatusChange && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-w-[5rem]"
                        aria-label={statusActionAriaLabel}
                        disabled={props.busy}
                        onClick={() => void props.onStatusChange?.(entry, props.archived ? 'active' : 'archived')}
                      >
                        {statusActionLabel}
                      </Button>
                    )}
                  </div>
                )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

