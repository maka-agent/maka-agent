import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type {
  PermissionRequestEvent,
  PermissionResponse,
  PublicToolIntentReview,
  ToolCategory,
} from '@maka/core';
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
  review: PublicToolIntentReview;
  ageMs?: number;
  rememberForTurnAllowed: boolean;
}): PermissionRequestEvent {
  return {
    kind: 'tool_permission',
    id: `evt-${input.requestId}`,
    turnId: `turn-${input.requestId}`,
    type: 'permission_request',
    requestId: input.requestId,
    toolUseId: `${input.requestId}-call`,
    toolName: input.toolName,
    category: input.category,
    reason: input.reason,
    review: input.review,
    ts: NOW - (input.ageMs ?? 0),
    rememberForTurnAllowed: input.rememberForTurnAllowed,
  };
}

function ComposerSlotBackdrop(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
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

const writeStdinRequest = makeRequest({
  requestId: 'req-stdin',
  toolName: 'WriteStdin',
  category: 'shell_unsafe',
  reason: 'shell_dangerous',
  review: {
    kind: 'stdin',
    ref: 'maka://runtime/background-tasks/pty-1',
    input: {
      text: String.raw`password=REDACTED diagnostic \u{001B}[31mrm -rf /tmp/example\r`,
      bytes: 74,
    },
    size: { cols: 120, rows: 40 },
  },
  rememberForTurnAllowed: false,
});

function WriteStdinPrompt(props: {
  onRespond(response: PermissionResponse): void | Promise<void>;
}) {
  return (
    <ComposerSlotBackdrop>
      <PermissionPromptStory request={writeStdinRequest} onRespond={props.onRespond} />
    </ComposerSlotBackdrop>
  );
}

export const ShellDangerous: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-shell',
          toolName: 'Bash',
          category: 'shell_unsafe',
          reason: 'shell_dangerous',
          rememberForTurnAllowed: true,
          review: {
            kind: 'command',
            command: 'rm -rf node_modules dist && npm ci',
            cwd: '/workspace/maka-agent',
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const WriteStdin: Story = {
  render: () => <WriteStdinPrompt onRespond={noop} />,
};

const writeStdinRespond = fn();

export const WriteStdinInteraction: Story = {
  render: () => <WriteStdinPrompt onRespond={writeStdinRespond} />,
  play: async ({ canvasElement }) => {
    writeStdinRespond.mockClear();
    const document = canvasElement.ownerDocument;
    const body = within(document.body);
    const collapsedText = document.body.textContent ?? '';

    await expect(collapsedText).toContain('maka://runtime/background-tasks/pty-1');
    await expect(collapsedText).toContain('120x40');
    await expect(collapsedText).not.toContain('super-secret');
    await expect(collapsedText).toContain('/tmp/example');
    await expect(body.queryByRole('checkbox')).toBeNull();

    await userEvent.click(body.getByRole('button', { name: '查看输入' }));
    const inspection = document.querySelector<HTMLElement>('.maka-permission-details .maka-code');
    await expect(inspection).not.toBeNull();
    const inspectionText = inspection?.textContent ?? '';
    await expect(inspectionText).toContain('REDACTED');
    await expect(inspectionText).not.toContain('super-secret');
    await expect(inspectionText).toContain(String.raw`\u{001B}[31mrm -rf /tmp/example\r`);
    await expect(inspectionText).not.toContain('\u001b');
    await expect(inspectionText).toContain('size: 120x40');

    await userEvent.click(body.getByRole('button', { name: '允许操作' }));
    await expect(writeStdinRespond).toHaveBeenCalledWith({
      requestId: 'req-stdin',
      decision: 'allow',
    });
  },
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
          rememberForTurnAllowed: true,
          review: {
            kind: 'path',
            operation: 'write',
            path: 'src/renderer/app-shell.tsx',
            cwd: '/workspace/maka-agent',
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
          rememberForTurnAllowed: true,
          review: {
            kind: 'path',
            operation: 'edit',
            path: 'packages/ui/src/composer.tsx',
            cwd: '/workspace/maka-agent',
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
          rememberForTurnAllowed: true,
          review: {
            kind: 'path',
            operation: 'edit',
            path: 'packages/ui/src/composer.tsx',
            cwd: '/workspace/maka-agent',
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
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
          rememberForTurnAllowed: true,
          review: { kind: 'command', command: 'git clean -fdx', cwd: '/workspace/maka-agent' },
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
          rememberForTurnAllowed: true,
          review: { kind: 'command', command: 'git push --force origin main', cwd: '/workspace/maka-agent' },
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
          rememberForTurnAllowed: true,
          review: {
            kind: 'web',
            targetKind: 'url',
            target: 'https://api.github.com/repos/maka-agent/maka/releases/latest',
          },
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
          rememberForTurnAllowed: true,
          review: {
            kind: 'command',
            command: 'sudo systemctl restart maka-agent',
            cwd: '/workspace/maka-agent',
          },
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
          rememberForTurnAllowed: true,
          review: { kind: 'browser', action: 'navigate', url: 'https://example.com' },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const ComputerUse: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-computer-use',
          toolName: 'maka_computer',
          category: 'computer_use',
          reason: 'computer_use',
          rememberForTurnAllowed: true,
          review: {
            kind: 'computer_use',
            action: 'left_click',
            app: 'Example App',
            windowId: 42,
          },
        })}
        onRespond={noop}
      />
    </ComposerSlotBackdrop>
  ),
};

export const FormatJson: Story = {
  render: () => (
    <ComposerSlotBackdrop>
      <PermissionPromptStory
        request={makeRequest({
          requestId: 'req-office',
          toolName: 'FormatJson',
          category: 'file_write',
          reason: 'file_write',
          rememberForTurnAllowed: true,
          review: {
            kind: 'path',
            operation: 'format_json',
            path: 'reports/Q3-roadmap.json',
            cwd: '/workspace/maka-agent',
            sortKeys: true,
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
          rememberForTurnAllowed: true,
          review: {
            kind: 'command',
            command: 'npm run build && npm run test',
            cwd: '/workspace/maka-agent',
          },
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
          rememberForTurnAllowed: true,
          review: { kind: 'path', operation: 'write', path: 'README.md', cwd: '/workspace/maka-agent' },
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
          toolName: 'StopBackgroundTask',
          category: 'custom_tool',
          reason: 'custom',
          rememberForTurnAllowed: false,
          review: {
            kind: 'runtime_resource',
            operation: 'stop',
            ref: 'maka://runtime/background-tasks/build-1',
          },
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
          rememberForTurnAllowed: true,
          review: { kind: 'command', command: 'npm run deploy', cwd: '/workspace/maka-agent' },
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
