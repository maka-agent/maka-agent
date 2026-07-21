import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CapabilityAuditReport } from '@maka/core';
import { CapabilityAuditStrip } from '../src/capability-audit-strip.js';

const meta = {
  title: 'Product/Capability Audit Strip',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW = Date.now();

function report(input: Partial<CapabilityAuditReport['summary']>): CapabilityAuditReport {
  return {
    checkedAt: NOW,
    sources: [],
    skills: [],
    automations: [],
    summary: {
      sourceCount: 0,
      readySourceCount: 0,
      needsAuthSourceCount: 0,
      errorSourceCount: 0,
      disabledSourceCount: 0,
      skillCount: 0,
      enabledSkillCount: 0,
      skillsWithDeclaredTools: 0,
      declaredToolKindCount: 0,
      automationCount: 0,
      enabledAutomationCount: 0,
      executableAutomationCount: 0,
      failedAutomationCount: 0,
      skippedAutomationCount: 0,
      ...input,
    },
  };
}

function StripFrame(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        padding: 24,
        width: '100%',
        maxWidth: 720,
        margin: '0 auto',
      }}
    >
      {props.children}
    </div>
  );
}

export const SkillsFocusHealthy: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip
        report={report({
          sourceCount: 3,
          readySourceCount: 3,
          skillCount: 8,
          enabledSkillCount: 6,
          skillsWithDeclaredTools: 5,
          declaredToolKindCount: 4,
        })}
      />
    </StripFrame>
  ),
};

export const AutomationsFocusHealthy: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip
        report={report({
          sourceCount: 2,
          readySourceCount: 2,
          automationCount: 5,
          enabledAutomationCount: 4,
          executableAutomationCount: 4,
        })}
      />
    </StripFrame>
  ),
};

export const WithRisks: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip
        report={report({
          sourceCount: 4,
          readySourceCount: 2,
          needsAuthSourceCount: 1,
          errorSourceCount: 1,
          skillCount: 10,
          enabledSkillCount: 7,
          skillsWithDeclaredTools: 6,
          declaredToolKindCount: 5,
          automationCount: 6,
          enabledAutomationCount: 5,
          executableAutomationCount: 4,
          failedAutomationCount: 1,
          skippedAutomationCount: 1,
        })}
      />
    </StripFrame>
  ),
};

export const Empty: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip report={report({})} />
    </StripFrame>
  ),
};
