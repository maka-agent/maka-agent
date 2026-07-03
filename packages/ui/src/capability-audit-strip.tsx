import type { CapabilityAuditReport } from '@maka/core';

export function CapabilityAuditStrip(props: { report: CapabilityAuditReport; focus: 'skills' | 'automations' }) {
  const report = props.report;
  // Metric labels live in the <dt> (来源/技能/自动化) — the <dd> only
  // carries count + state so the strip doesn't read「技能 3/3 技能启用」.
  const sourceCopy = report.summary.sourceCount === 0
    ? '暂无'
    : `${report.summary.readySourceCount}/${report.summary.sourceCount} 就绪`;
  const skillCopy = `${report.summary.enabledSkillCount}/${report.summary.skillCount} 启用`;
  const automationCopy = `${report.summary.enabledAutomationCount}/${report.summary.automationCount} 启用`;
  const riskCopy = capabilityAuditRiskCopy(report);
  const primaryCopy = props.focus === 'skills'
    ? `${report.summary.declaredToolKindCount} 类声明工具`
    : `${report.summary.executableAutomationCount} 个可执行自动化`;

  return (
    <section className="maka-capability-audit-strip" aria-label="能力审计摘要">
      <div className="maka-capability-audit-copy">
        <span className="maka-capability-audit-kicker">能力审计</span>
        <strong>{primaryCopy}</strong>
        <small>{riskCopy}</small>
      </div>
      <dl className="maka-capability-audit-metrics" aria-label="来源、技能、自动化状态">
        <div>
          <dt>来源</dt>
          <dd>{sourceCopy}</dd>
        </div>
        <div>
          <dt>技能</dt>
          <dd>{skillCopy}</dd>
        </div>
        <div>
          <dt>自动化</dt>
          <dd>{automationCopy}</dd>
        </div>
      </dl>
    </section>
  );
}

function capabilityAuditRiskCopy(report: CapabilityAuditReport): string {
  const issues: string[] = [];
  if (report.summary.needsAuthSourceCount > 0) issues.push(`${report.summary.needsAuthSourceCount} 个来源等待授权`);
  if (report.summary.errorSourceCount > 0) issues.push(`${report.summary.errorSourceCount} 个来源异常`);
  if (report.summary.failedAutomationCount > 0) issues.push(`${report.summary.failedAutomationCount} 个自动化上次失败`);
  if (report.summary.skippedAutomationCount > 0) issues.push(`${report.summary.skippedAutomationCount} 个自动化上次跳过`);
  if (issues.length === 0) return 'Skill 声明工具只作为权限请求展示；不会放大当前会话权限。';
  return issues.join(' · ');
}
