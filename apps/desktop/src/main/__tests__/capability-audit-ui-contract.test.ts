import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveCapabilityAuditReport } from '@maka/core';
import { CapabilityAuditStrip } from '@maka/ui';
import { readRendererContractCss } from './contract-css-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

describe('capability audit visible system contract', () => {
  it('renders sources, skills, and automations status without widening skill permissions', () => {
    const report = deriveCapabilityAuditReport({
      now: 1_700_000_000_000,
      skills: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'Drafts release notes.',
          declaredTools: ['Read', 'Write', 'Bash'],
        },
      ],
      planReminders: [
        {
          id: 'plan-1',
          title: '每日复盘',
          note: '',
          schedule: { kind: 'recurring', startAt: 1_700_000_000_000, recurrence: 'daily' },
          delivery: { channel: 'local' },
          status: 'scheduled',
          enabled: true,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          nextRunAt: 1_700_003_600_000,
          lastRun: { id: 'run-1', at: 1_700_001_000_000, status: 'failed', message: 'failed' },
          runs: [],
          runCount: 1,
        },
      ],
    });

    const markup = renderToStaticMarkup(createElement(CapabilityAuditStrip, { report, focus: 'skills' }));

    assert.match(markup, /aria-label="能力审计摘要"/);
    assert.match(markup, /能力审计/);
    assert.match(markup, /3 类声明工具/);
    assert.match(markup, /来源<\/dt><dd>1\/1 就绪/);
    assert.match(markup, /技能<\/dt><dd>1\/1 启用/);
    assert.match(markup, /自动化<\/dt><dd>1\/1 启用/);
    assert.match(markup, /1 个自动化上次失败/);
    assert.equal(report.skills[0].permissionMode, 'ask');
    assert.notEqual(report.skills[0].permissionMode, 'execute');
  });

  it('wires ChatView through a single derived audit report for Skills and Automations', async () => {
    const components = await readFile(join(repoRoot, 'packages', 'ui', 'src', 'chat-view.tsx'), 'utf8');

    assert.match(
      components,
      /const capabilityAuditReport = useMemo\([\s\S]*deriveCapabilityAuditReport\(\{[\s\S]*skills: props\.skills \?\? \[\],[\s\S]*planReminders: props\.planReminders \?\? \[\],[\s\S]*\}\)/,
      'ChatView must derive the capability audit report from the same skills and plan-reminder snapshots',
    );
    assert.match(
      components,
      /<SkillsModuleMain[\s\S]*auditReport=\{capabilityAuditReport\}/,
      'Skills module must receive the shared capability audit report',
    );
    assert.match(
      components,
      /<PlanReminderPanel[\s\S]*auditReport=\{capabilityAuditReport\}/,
      'Automations module must receive the shared capability audit report',
    );
  });

  it('keeps the audit strip as a full-width band with responsive metrics', async () => {
    const styles = await readRendererContractCss();

    assert.match(styles, /\.maka-capability-audit-strip\s*\{[\s\S]*display:\s*flex/);
    assert.match(styles, /\.maka-capability-audit-metrics\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(92px, 1fr\)\)/);
    assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*\.maka-capability-audit-strip\s*\{[\s\S]*display:\s*grid/);
    assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*\.maka-capability-audit-metrics\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});
