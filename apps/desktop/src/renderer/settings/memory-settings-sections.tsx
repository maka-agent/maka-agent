import { Button } from '@maka/ui';
import { workspaceInstructionStatusLabel } from './memory-settings-labels';

type WorkspaceInstructionState = Awaited<ReturnType<typeof window.maka.workspaceInstructions.getState>>;

export function WorkspaceInstructionsSection(props: {
  state: WorkspaceInstructionState | null;
  disabled: boolean;
  isActionPending(key: string): boolean;
  onOpen(file: string): void | Promise<void>;
  onCreate(file: string): void | Promise<void>;
}) {
  if (!props.state) return null;
  return (
    <div className="settingsMemoryPreview">
      <strong>检测到 {props.state.detectedCount} 个项目指令文件</strong>
      <small>
        单文件最多读取 {props.state.fileCharLimit.toLocaleString('zh-CN')} 字符；只显示状态，不在这里展示内容。
      </small>
      <div className="settingsConnectionMeta">
        {props.state.files.map((file) => (
          <span key={file.file} className="settingsInlineFileState">
            <span>{file.file} · {workspaceInstructionStatusLabel(file.status, file.chars, file.truncated)}</span>
            {(file.status === 'available' || file.status === 'empty') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-[4rem]"
                aria-label={`打开项目指令文件 ${file.file}`}
                disabled={props.disabled || props.isActionPending(`instruction:${file.file}:open`)}
                onClick={() => void props.onOpen(file.file)}
              >
                {props.isActionPending(`instruction:${file.file}:open`) ? '打开中…' : '打开'}
              </Button>
            )}
            {file.status === 'missing' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-[4rem]"
                aria-label={`创建项目指令文件 ${file.file}`}
                disabled={props.disabled || props.isActionPending(`instruction:${file.file}:create`)}
                onClick={() => void props.onCreate(file.file)}
              >
                {props.isActionPending(`instruction:${file.file}:create`) ? '创建中…' : '创建'}
              </Button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MemoryPromptPreviewSection(props: {
  active: boolean;
  preview: string;
  budgetLabel: string;
  blockedReason: string;
  safeMode: boolean;
  copyPending: boolean;
  onCopy(): void | Promise<void>;
}) {
  return (
    <div className="settingsMemoryPromptPreview" data-active={props.active ? 'true' : 'false'}>
      <div className="settingsMemoryPromptPreviewHeader">
        <strong>模型上下文预览</strong>
        <div>
          <span>{props.active ? '发送时会注入' : '当前不会注入'}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[5rem]"
            disabled={!props.preview || props.copyPending}
            onClick={() => void props.onCopy()}
          >
            {props.copyPending ? '复制中…' : '复制上下文'}
          </Button>
        </div>
      </div>
      <small>只展示生效记忆会进入 prompt 的内容；已归档条目不会注入，疑似密钥会遮蔽。</small>
      <small className="settingsMemoryPromptPreviewBudget">{props.budgetLabel}</small>
      {props.preview ? (
        <pre>{props.preview}</pre>
      ) : (
        <p>{props.safeMode ? 'MEMORY.md 过大，当前不会生成模型上下文预览。' : '没有生效记忆会进入 prompt。'}</p>
      )}
      {props.blockedReason && props.preview && <small>{props.blockedReason}</small>}
    </div>
  );
}
