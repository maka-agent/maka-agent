import type { Meta, StoryObj } from '@storybook/react-vite';
import { Markdown, MakaUriContext } from '../src/markdown.js';
import { Bubble } from '../src/primitives/chat.js';

const meta = {
  title: 'Product/Markdown',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function ProseFrame(props: { children: React.ReactNode; width?: number }) {
  return (
    <div
      data-maka-visual-smoke="true"
      style={{
        background: 'var(--surface-canvas)',
        padding: 24,
      }}
    >
      <div style={{ margin: '0 auto', maxWidth: props.width ?? 720, width: '100%' }}>
        {props.children}
      </div>
    </div>
  );
}

// Build a fenced code block without dropping raw backticks into a JS
// template literal (which makes the closing fence eat the template's
// terminating backtick).
function code(lang: string, body: string): string {
  const open = '```' + lang;
  const close = '```';
  return [open, body, close].join('\n');
}

const noop = () => undefined;

const tsBlock = code('ts', [
  'type SessionGroup = {',
  '  id: SessionStatus;',
  '  label: string;',
  '  sessions: SessionSummary[];',
  '  collapsible: boolean;',
  '};',
  '',
  'export function deriveSessionStatusGroups(',
  '  sessions: readonly SessionSummary[],',
  '): SessionGroup[] {',
  '  return [];',
  '}',
].join('\n'));

const bashBlock = code('bash', 'npm run build && npm run test');

const jsonBlock = code('json', [
  '{',
  '  "status": "running",',
  '  "sessionId": "session-42",',
  '  "startedAt": 1782000000000',
  '}',
].join('\n'));

const plainBlock = code('', 'plain or unknown\nindented sample');

export const RichAssistantAnswer: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '## 改动思路',
            '',
            '这次把会话列表的状态分组收敛到一处派生，侧栏只负责渲染。好处是**同一段排序逻辑**在测试里可以直接喂入数据，不用驱动整个渲染器。',
            '',
            '主要做了三件事：',
            '',
            '1. 新增 `deriveSessionStatusGroups`，输入是会话快照，输出是带分组标签的结构；',
            '2. 侧栏改为消费这个结构，不再自己维护 `running` / `waiting` 的顺序；',
            '3. 补了边界用例，包括已归档和已中止的会话。',
            '',
            '> 注意：置顶会话仍单独浮顶，沿用 PR48 的行为，没有改动它。',
            '',
            '| 状态 | 含义 | 是否默认展开 |',
            '| --- | --- | --- |',
            '| running | 工具链在跑 | 是 |',
            '| waiting_for_user | 等权限 | 是 |',
            '| blocked | 已阻塞 | 是 |',
            '| archived | 归档 | 否 |',
            '',
            '如果后续要加新状态，先在 `SessionStatus` 里登记，再让派生函数返回对应分组即可。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

export const CodeBlockVariety: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '下面是几种常见代码块，用来核对语言标签和复制按钮。',
            '',
            tsBlock,
            '',
            bashBlock,
            '',
            jsonBlock,
            '',
            '未标语言的代码块也会被高亮：',
            '',
            plainBlock,
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

export const ListsAndQuote: Story = {
  render: () => (
    <ProseFrame>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '可以按下面顺序处理：',
            '',
            '- 先确认 `SessionStatus` 的取值范围',
            '  - 已归档和已中止要单独分组',
            '  - 置顶的浮在最上面',
            '- 再调整侧栏渲染',
            '- 最后补回归测试',
            '',
            '1. 读 `session-status-grouping.ts`',
            '2. 改 `session-list-panel.tsx`',
            '3. 跑 `npm run test`',
            '',
            '> 这里的顺序不是强制的，只要回归测试先跑就行。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};

export const LinkRouting: Story = {
  render: () => (
    <ProseFrame>
      <MakaUriContext.Provider value={noop}>
        <Bubble variant="assistant" className="maka-bubble-with-actions">
          <Markdown
            text={[
              '这里有三类链接，用来核对内部路由和安全过滤。',
              '',
              '外链会新窗口打开：[项目仓库](https://github.com/example/maka)。',
              '',
              '内部链接走应用内导航：',
              '- [去设置 · 模型](maka://settings?section=models)',
              '- [把这段写进输入框](maka://compose?text=帮我看看这个)',
              '',
              '下面这些会被拦成不可点的"链接无效"：',
              '',
              '- 不安全的 scheme：[点我](javascript:alert(1))',
              '- 内部链接但目标不合法：[坏链接](maka://tool/run)',
              '',
              '链接外的正文 `inline code` 和普通文字不受影响。',
            ].join('\n')}
          />
        </Bubble>
      </MakaUriContext.Provider>
    </ProseFrame>
  ),
};

export const LongFormArticle: Story = {
  render: () => (
    <ProseFrame width={680}>
      <Bubble variant="assistant" className="maka-bubble-with-actions">
        <Markdown
          text={[
            '# Storybook 表面覆盖：为什么单独可看很重要',
            '',
            '当一次改动同时影响多个状态时，靠手动把桌面 app 驱动到每条路径太慢，也容易漏。把每个可见状态固定成 Storybook 的一帧，reviewer 可以逐个点开核对，回归截图也能自动比对。',
            '',
            '## 范围',
            '',
            '这次补的主要是高频但此前没有 story 的页面：',
            '',
            '- 权限弹窗（8 种 reason + 3 种 health）',
            '- 顶层布局（侧栏 + 主区 + overlay 堆叠）',
            '- 首次启动引导',
            '',
            '## 非目标',
            '',
            '`AppShell` 这个集成根不在 Storybook 里整体挂载。它深度依赖 `window.maka` 的 IPC，整体挂载需要造一整套 mock，维护成本高、容易脆。改为用真实的子组件拼出布局，能稳定反映页面长什么样。',
            '',
            '| 页面 | 方式 | 原因 |',
            '| --- | --- | --- |',
            '| 权限弹窗 | 直接挂载 | 叶子组件，props 驱动 |',
            '| 顶层布局 | 组合子组件 | 避开 IPC 耦合 |',
            '| 设置各页 | 桥接 mock | 已有 `ConnectionsBridge` 模式 |',
            '',
            '## 验证',
            '',
            '写完后跑一次 `npm run build-storybook`，确认所有 story 编译通过；再视情况补回归截图。',
          ].join('\n')}
        />
      </Bubble>
    </ProseFrame>
  ),
};
