import { classifyToolUse } from '@maka/core/permission';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { PlanExecution, PlanProposal } from '@maka/core/plan';

import type { MakaTool } from './tool-runtime.js';

const PLAN_CONTROL_TOOLS = new Set(['SubmitPlan', 'update_plan', 'cancel_plan']);

export function selectCollaborationTools(input: {
  mode: CollaborationMode;
  tools: readonly MakaTool[];
  hasActiveExecution: boolean;
}): MakaTool[] {
  if (input.mode === 'plan') {
    return input.tools.filter((tool) => {
      if (tool.name === 'SubmitPlan' || tool.name === 'AskUserQuestion') return true;
      if (PLAN_CONTROL_TOOLS.has(tool.name)) return false;
      const category = classifyToolUse({
        toolName: tool.name,
        args: {},
        ...(tool.categoryHint ? { categoryHint: tool.categoryHint } : {}),
      });
      return category === 'read' || category === 'web_read';
    });
  }

  return input.tools.filter((tool) => {
    if (tool.name === 'SubmitPlan') return false;
    if (tool.categoryHint === 'subagent' && input.hasActiveExecution) return false;
    if (tool.name === 'update_plan' || tool.name === 'cancel_plan') {
      return input.hasActiveExecution;
    }
    return true;
  });
}

export function renderPlanModePrompt(): string {
  return [
    '<collaboration_mode>',
    '# Collaboration Mode: Plan',
    'You are planning only. Inspect the repository and discuss tradeoffs, but do not modify files or perform side effects.',
    'Use AskUserQuestion only when a bounded answer is required. Subagents are unavailable in this mode.',
    'When the plan is ready for approval, call SubmitPlan exactly once with a concise title, overview, ordered steps, and material risks.',
    'Do not claim that implementation has started or completed.',
    '</collaboration_mode>',
  ].join('\n');
}

export function renderPlanExecutionPrompt(input: {
  proposal: PlanProposal;
  execution: PlanExecution;
}): string {
  const steps = input.execution.steps
    .map((step) => `- [${statusMark(step.status)}] ${step.id}: ${step.description}`)
    .join('\n');
  return [
    '<plan_execution_context>',
    `Plan: ${input.proposal.title}`,
    `Plan ID: ${input.proposal.planId}`,
    `Proposal: ${input.proposal.proposalId} (revision ${input.proposal.revision})`,
    `Execution ID: ${input.execution.executionId}`,
    input.proposal.overview ? `Overview: ${input.proposal.overview}` : '',
    'Approved steps:',
    steps,
    'Execute this approved plan. Use update_plan to keep progress current. If the user explicitly abandons the plan, call cancel_plan. Do not delegate to subagents while this execution is active.',
    '</plan_execution_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

function statusMark(status: PlanExecution['steps'][number]['status']): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '>';
  if (status === 'skipped') return '-';
  return ' ';
}
