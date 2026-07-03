import type { Meta, StoryObj } from '@storybook/react-vite';
import { SkillsModuleMain } from '../src/skills-panel.js';
import type { SkillEntry } from '../src/module-panel-types.js';

const meta = {
  title: 'Product/Skills',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => undefined;

const skills: SkillEntry[] = [
  {
    id: 'skill-git-flow',
    name: 'git-flow',
    description: '封装分支创建、合并与发布打 tag 的常用 git 操作。',
    path: '~/.maka/skills/git-flow',
    declaredTools: ['Bash', 'Write'],
  },
  {
    id: 'skill-docs-screenshot',
    name: 'docs-screenshot',
    description: '把组件截图同步进设计文档，按 token 分类命名。',
    path: '~/.maka/skills/docs-screenshot',
    declaredTools: ['Bash', 'Read'],
  },
  {
    id: 'skill-release-notes',
    name: 'release-notes',
    description: '从最近的 commit 历史生成发布说明草稿。',
    path: '~/.maka/skills/release-notes',
    declaredTools: ['Bash'],
  },
];

function ModuleFrame(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-visual-smoke="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
      }}
    >
      <div
        className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
        style={{ height: '100%', overflow: 'auto' }}
      >
        {props.children}
      </div>
    </div>
  );
}

export const Populated: Story = {
  render: () => (
    <ModuleFrame>
      <SkillsModuleMain
        skills={skills}
        onRefreshSkills={noop}
        onCreateSkillTemplate={noop}
        onOpenSkill={noop}
        onOpenSkillsFolder={noop}
      />
    </ModuleFrame>
  ),
};

export const Empty: Story = {
  render: () => (
    <ModuleFrame>
      <SkillsModuleMain
        skills={[]}
        onRefreshSkills={noop}
        onCreateSkillTemplate={noop}
        onOpenSkill={noop}
        onOpenSkillsFolder={noop}
      />
    </ModuleFrame>
  ),
};
