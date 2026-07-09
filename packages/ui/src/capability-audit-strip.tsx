import type { CapabilityAuditReport } from '@maka/core';
import { Alert, AlertDescription } from './primitives/alert.js';

/**
 * Designer audit P1-7: this used to be a full-width "能力审计" band on both
 * the Skills and Automations pages — engineering jargon ("3 类声明工具",
 * "自动化 0/0 启用") plus counts the page tabs already show. Healthy state
 * carried zero new information, so the strip now reports by exception:
 * render a single warning line when something needs attention (sources
 * waiting for auth / erroring, automations that failed or were skipped
 * last run), and render nothing at all when everything is fine.
 */
export function CapabilityAuditStrip(props: { report: CapabilityAuditReport; focus?: 'skills' | 'automations' }) {
  const issues = capabilityAuditIssues(props.report);
  if (issues.length === 0) return null;
  return (
    <Alert variant="warning" className="maka-capability-audit-strip" aria-label="能力风险提示">
      <AlertDescription>{issues.join(' · ')}</AlertDescription>
    </Alert>
  );
}

export function capabilityAuditIssues(report: CapabilityAuditReport): string[] {
  const issues: string[] = [];
  if (report.summary.needsAuthSourceCount > 0) issues.push(`${report.summary.needsAuthSourceCount} 个来源等待授权`);
  if (report.summary.errorSourceCount > 0) issues.push(`${report.summary.errorSourceCount} 个来源异常`);
  if (report.summary.failedAutomationCount > 0) issues.push(`${report.summary.failedAutomationCount} 个自动化上次失败`);
  if (report.summary.skippedAutomationCount > 0) issues.push(`${report.summary.skippedAutomationCount} 个自动化上次跳过`);
  return issues;
}
