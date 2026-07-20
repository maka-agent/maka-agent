import { useCallback, useEffect, useState, type JSX } from 'react';
import type { PlanSessionState, SessionEvent, SessionSummary } from '@maka/core';

export function PlanModePanel(props: {
  session: SessionSummary | undefined;
  disabled: boolean;
  onSessionChanged: (session: SessionSummary) => void;
}): JSX.Element | null {
  const { session } = props;
  const [state, setState] = useState<PlanSessionState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!session) return;
    setState(await window.maka.sessions.getPlanState(session.id));
  }, [session?.id]);

  useEffect(() => {
    setState(undefined);
    setError(undefined);
    if (!session) return;
    void refresh().catch((cause) => setError(message(cause)));
    return window.maka.sessions.subscribeEvents(session.id, (event: SessionEvent) => {
      if (event.type === 'plan_submitted' || event.type === 'complete' || event.type === 'abort') {
        void refresh().catch(() => {});
      }
    });
  }, [session?.id, refresh]);

  if (!session) return null;
  const mode = session.collaborationMode ?? 'agent';
  const proposal = state?.proposals.find((item) => item.proposalId === state.latestProposalId);
  const active = state?.executions.find((item) => item.executionId === state.activeExecutionId);
  const interrupted = [...(state?.executions ?? [])].reverse().find(
    (item) => item.status === 'interrupted',
  );

  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="plan-mode-panel" aria-label="计划模式">
      <button
        type="button"
        className={mode === 'plan' ? 'plan-mode-toggle is-active' : 'plan-mode-toggle'}
        disabled={props.disabled || pending || Boolean(active)}
        onClick={() => void run(async () => {
          const next = await window.maka.sessions.setCollaborationMode(
            session.id,
            mode === 'plan' ? 'agent' : 'plan',
          );
          props.onSessionChanged(next);
        })}
      >
        {mode === 'plan' ? 'Plan Mode' : 'Agent Mode'}
      </button>

      {proposal?.status === 'pending_approval' && (
        <div className="plan-proposal-card">
          <div className="plan-proposal-heading">
            <strong>{proposal.title}</strong>
            <span>Revision {proposal.revision}</span>
          </div>
          {proposal.overview && <p>{proposal.overview}</p>}
          <ol>
            {proposal.steps.map((step) => <li key={step.id}>{step.description}</li>)}
          </ol>
          {proposal.risks && proposal.risks.length > 0 && (
            <p className="plan-proposal-risks">风险：{proposal.risks.join('；')}</p>
          )}
          <div className="plan-proposal-actions">
            <button type="button" disabled={pending} onClick={() => void run(async () => {
              await window.maka.sessions.requestPlanRevision(session.id, proposal.proposalId);
            })}>继续修改</button>
            <button type="button" className="is-primary" disabled={pending} onClick={() => void run(async () => {
              await window.maka.sessions.approvePlan(session.id, {
                proposalId: proposal.proposalId,
                expectedRevision: proposal.revision,
                expectedStoreVersion: state?.storeVersion,
              });
            })}>执行计划</button>
          </div>
        </div>
      )}

      {active && (
        <div className="plan-execution-progress">
          <strong>正在执行：{proposal?.title ?? '已批准计划'}</strong>
          <span>{active.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length}/{active.steps.length}</span>
        </div>
      )}

      {!active && interrupted && (
        <button type="button" className="plan-resume-button" disabled={pending} onClick={() => void run(async () => {
          await window.maka.sessions.resumePlan(session.id, interrupted.executionId);
        })}>恢复中断的计划</button>
      )}
      {error && <p className="plan-mode-error" role="alert">{error}</p>}
    </section>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
