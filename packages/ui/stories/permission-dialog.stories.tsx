import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PermissionRequestEvent, ToolCategory } from '@maka/core';
import { PermissionPrompt } from '../src/permission-dialog.js';

const meta = {
  title: 'Product/Permission Prompt',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function PermissionPromptStory(props: Omit<Parameters<typeof PermissionPrompt>[0], 'onStop'>) {
  return <PermissionPrompt {...props} onStop={() => undefined} />;
}

const NOW = Date.now();

function makeRequest(input: {
  requestId: string;
  toolName: string;
  category: ToolCategory;
  reason: PermissionRequestEvent['reason'];
  args: unknown;
  hint?: string;
  ageMs?: number;
}): PermissionRequestEvent {
  return {
    id: `evt-${input.requestId}`,
    turnId: `turn-${input.requestId}`,
    type: 'permission_request',
    requestId: input.requestId,
    toolUseId: `${input.requestId}-call`,
    toolName: input.toolName,
    category: input.category,
    reason: input.reason,
    args: input.args,
    ts: NOW - (input.ageMs ?? 0),
    ...(input.hint ? { hint: input.hint } : {}),
  };
}

function ComposerSlotBackdrop(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-visual-smoke="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      {props.children}
    </div>
  );
}

const noop = () => undefined;

export const ShellDangerous: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-shell',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          args: { command: 'rm -rf node_modules dist && npm ci', timeout_ms: 120000 },
          hint: '这条命令会删除目录再重装依赖，请确认在正确的项目根目录执行。',
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const FileWrite: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-write',
          toolName: 'Write',
          category: 'file_write',
          reason: 'file_write',
          args: {
            path: 'src/renderer/app-shell.tsx',
            content: 'import { AppShell } from "./app-shell";\n\nexport function main() {\n  return <AppShell />;\n}\n',
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const FileEdit: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-edit',
          toolName: 'Edit',
          category: 'file_write',
          reason: 'file_write',
          args: {
            path: 'packages/ui/src/composer.tsx',
            old_string: 'const placeholder = "给 Maka 发消息…";',
            new_string: 'const placeholder = "问点什么…";',
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const FileEditExpanded: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-edit-expanded',
          toolName: 'Edit',
          category: 'file_write',
          reason: 'file_write',
          args: {
            path: 'packages/ui/src/composer.tsx',
            old_string: 'const placeholder = "给 Maka 发消息…";\n'.repeat(18),
            new_string: 'const placeholder = "描述任务…";\n'.repeat(18),
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
  play: async ({ canvasElement }) => {
    await wait(0);
    const disclosure = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => (button.textContent ?? '').includes('完整参数'));
    disclosure?.click();
  },
};

export const FsDestructive: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-fs',
          toolName: 'Bash',
          category: 'fs_destructive',
          reason: 'fs_destructive',
          args: { command: 'git clean -fdx' },
          hint: '不可恢复：这会删除所有未跟踪的文件和目录。',
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const GitDestructive: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-git',
          toolName: 'Bash',
          category: 'git_destructive',
          reason: 'git_destructive',
          args: { command: 'git push --force origin main' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const Network: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-net',
          toolName: 'WebFetch',
          category: 'web_read',
          reason: 'network',
          args: { url: 'https://api.github.com/repos/maka-agent/maka/releases/latest' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const Privileged: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-sudo',
          toolName: 'Bash',
          category: 'privileged',
          reason: 'privileged',
          args: { command: 'sudo systemctl restart maka-agent' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const Browser: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-browser',
          toolName: 'browser_navigate',
          category: 'browser',
          reason: 'browser',
          args: { url: 'https://example.com', ref: 'main' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const OfficeDocumentEdit: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-office',
          toolName: 'OfficeDocumentEdit',
          category: 'file_write',
          reason: 'file_write',
          args: {
            path: 'reports/Q3-roadmap.docx',
            operation: 'replaceText',
            target: 'paragraph-42',
            elementType: 'paragraph',
            index: 41,
            props: { text: 'Q3 目标：补齐 Storybook 表面覆盖。' },
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const StaleRequest: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-stale',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          args: { command: 'npm run build && npm run test' },
          ageMs: 3 * 60_000,
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const ExpiredRequest: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-expired',
          toolName: 'Write',
          category: 'file_write',
          reason: 'file_write',
          args: { path: 'README.md', content: '# Maka' },
          ageMs: 11 * 60_000,
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const CustomReason: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-custom',
          toolName: 'MemoryWrite',
          category: 'custom_tool',
          reason: 'custom',
          args: { scope: 'project', content: '本仓库使用 pnpm，不要调用 npm install。' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

async function wait(ms: number) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export const SubmitPending: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-pending',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          args: { command: 'npm run deploy' },
        })}
        onRespond={() => new Promise<void>(() => undefined)}
      />
    </ComposerSlotBackdrop>
  ),
  play: async ({ canvasElement }) => {
    await wait(0);
    const allow = Array.from(canvasElement.ownerDocument.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => (button.textContent ?? '').includes('允许'));
    allow?.click();
  },
};
