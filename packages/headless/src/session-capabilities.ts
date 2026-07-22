import type {
  AgentListResult,
  AgentOutputInput,
  AgentOutputResult,
  PrepareChildAgentResumeResult,
  ResumeChildAgentInput,
  SessionManager,
  SpawnChildAgentInput,
  SpawnChildAgentResult,
} from '@maka/runtime';

export interface HeadlessSessionCapabilities {
  spawnChildAgent(sessionId: string, input: SpawnChildAgentInput): Promise<SpawnChildAgentResult>;
  prepareChildAgentResume(
    sessionId: string,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult>;
  resumeChildAgent(sessionId: string, input: ResumeChildAgentInput): Promise<SpawnChildAgentResult>;
  listChildAgents(sessionId: string): Promise<AgentListResult>;
  readChildAgentOutput(sessionId: string, input: AgentOutputInput): Promise<AgentOutputResult>;
}

export function createHeadlessSessionCapabilityBridge(): {
  capabilities: HeadlessSessionCapabilities;
  bind(manager: SessionManager): void;
} {
  let manager: SessionManager | undefined;
  const requireManager = (): SessionManager => {
    if (!manager) {
      throw new Error('Headless session capabilities are unavailable during backend registration');
    }
    return manager;
  };
  return {
    capabilities: {
      spawnChildAgent: async (sessionId, input) =>
        await requireManager().spawnChildAgent(sessionId, input),
      prepareChildAgentResume: async (sessionId, sourceRunId) =>
        await requireManager().prepareChildAgentResume(sessionId, sourceRunId),
      resumeChildAgent: async (sessionId, input) =>
        await requireManager().resumeChildAgent(sessionId, input),
      listChildAgents: async (sessionId) => await requireManager().listChildAgents(sessionId),
      readChildAgentOutput: async (sessionId, input) =>
        await requireManager().readChildAgentOutput(sessionId, input),
    },
    bind(nextManager) {
      if (manager) {
        throw new Error('Headless session capabilities are already bound');
      }
      manager = nextManager;
    },
  };
}
