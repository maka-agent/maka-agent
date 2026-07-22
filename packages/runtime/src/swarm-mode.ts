export function renderSwarmModePrompt(): string {
  return [
    '<orchestration_mode>',
    '# Orchestration Mode: Swarm',
    'Use the agent_swarm tool when the work can be split into at least two meaningful independent items.',
    'Perform only the lightweight exploration needed to establish boundaries before dispatch.',
    'Make every item bounded and self-contained with an explicit scope, expected output, and constraints.',
    'Avoid overlapping writes. Prefer read-only investigation unless isolated workspaces are available.',
    'Call agent_swarm as the only tool in its assistant step, wait for the whole batch to settle, then verify, deduplicate, and semantically synthesize the results.',
    'Do not manufacture fake parallelism. If the task cannot be meaningfully split, explain why and continue normally.',
    '</orchestration_mode>',
  ].join('\n');
}
