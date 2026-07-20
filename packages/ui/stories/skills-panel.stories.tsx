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

function skill(overrides: Partial<SkillEntry> & Pick<SkillEntry, 'id' | 'name' | 'description'>): SkillEntry {
  return {
    entryKey: `workspace:${overrides.id}`,
    displayPath: `skills/${overrides.id}`,
    discoveryOrigin: 'workspace',
    effective: true,
    metadataStatus: 'valid',
    operationalStatus: 'eligible',
    issues: [],
    requiredTools: [],
    requiredCapabilities: [],
    missingDeclaredTools: [],
    missingRequiredTools: [],
    missingRequiredCapabilities: [],
    declaredTools: [],
    enabled: true,
    runtimeStatus: 'enabled',
    canUse: false,
    canOpen: true,
    canToggle: false,
    canDelete: false,
    canUpdate: false,
    repairTarget: 'skill_file',
    ...overrides,
  };
}

const skills: SkillEntry[] = [
  skill({
    id: 'skill-git-flow',
    name: 'git-flow',
    description: '封装分支创建、合并与发布打 tag 的常用 git 操作。',
    declaredTools: ['Bash', 'Write'],
  }),
  skill({
    id: 'skill-docs-screenshot',
    name: 'docs-screenshot',
    description: '把组件截图同步进设计文档，按 token 分类命名。',
    declaredTools: ['Bash', 'Read'],
    enabled: false,
    runtimeStatus: 'disabled',
    operationalStatus: 'disabled',
    canUse: false,
  }),
  skill({
    id: 'skill-release-notes',
    name: 'release-notes',
    description: '从最近的 commit 历史生成发布说明草稿。',
    declaredTools: ['Bash'],
  }),
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
        onOpenSkill={noop}
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
        onOpenSkill={noop}
      />
    </ModuleFrame>
  ),
};
